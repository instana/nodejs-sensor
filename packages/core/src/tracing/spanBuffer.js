/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2016
 */

'use strict';

const tracingMetrics = require('./metrics');

let logger;
logger = require('../logger').getLogger('tracing/spanBuffer', newLogger => {
  logger = newLogger;
});

const batchableSpanNames = [];
let downstreamConnection = null;
let isActive = false;
let activatedAt = null;

let minDelayBeforeSendingSpans = 1000;
if (process.env.INSTANA_DEV_MIN_DELAY_BEFORE_SENDING_SPANS != null) {
  minDelayBeforeSendingSpans = parseInt(process.env.INSTANA_DEV_MIN_DELAY_BEFORE_SENDING_SPANS, 10);
  if (isNaN(minDelayBeforeSendingSpans)) {
    minDelayBeforeSendingSpans = 1000;
  }
}

let initialDelayBeforeSendingSpans;
let transmissionDelay;
let maxBufferedSpans;
let forceTransmissionStartingAt;
let transmissionTimeoutHandle;

let preActivationCleanupIntervalHandle;

let maxKeepAliveUntilSpanBufferIsEmpty;
const keepAliveCheckDelay = 100;
let keepEphemeralProcessAliveHandle;
let spanRequestInFlight = false;

let spans = [];

let batchThreshold = 10;
let batchingEnabled = false;
if (process.env.INSTANA_DEV_BATCH_THRESHOLD != null) {
  batchThreshold = parseInt(process.env.INSTANA_DEV_BATCH_THRESHOLD, 10);
  if (isNaN(batchThreshold)) {
    batchThreshold = 10;
  }
}
const batchBucketWidth = 18;

// We keep a map of maps to store spans that can potentially be batched, to find partner spans for batching quicker
// when a new batchable span arrives. (Otherwise we would have to iterate over _all_ spans in the span buffer whenever
// a batchable span is added.)
//
// The first level key is the trace ID, that is, we keep spans from different traces separate. The second key is the
// _end_ timestamp of the span (span.ts + span.d), rounded down to a multiple of 18 (batchBucketWidth). That is, we
// sort batchable spans in buckets that are 18 ms wide. When a new span arrives, we only have to examine two buckets
// (the bucket that the new span would land in and the previous one). Why 18? Because the distance between two span
// eligible to be merged together can be at most 18 ms (9 ms allowed gap between spans + 9 ms duration of the later
// span).
//
// By only inspecting the current and the previous bucket, we might miss possible batch pairs when a span that ended
// chronologically earlier (span.ts + span.d) is added to the buffer later than its potential partner. To guarantee
// that such pairs are also always found we would have to check the following bucket, too. Since this should be very
// rare, we omit the check, trading better perfomance for a few missed batch opportunities (if any).
//
// The batchingBuckets are cleared once the span buffer is flushed downstream.
const batchingBuckets = new Map();

exports.init = function init(config, _downstreamConnection) {
  downstreamConnection = _downstreamConnection;
  maxBufferedSpans = config.tracing.maxBufferedSpans;
  forceTransmissionStartingAt = config.tracing.forceTransmissionStartingAt;
  transmissionDelay = config.tracing.transmissionDelay;
  batchingEnabled = config.tracing.spanBatchingEnabled;
  initialDelayBeforeSendingSpans = Math.max(transmissionDelay, minDelayBeforeSendingSpans);

  if (config.tracing.activateImmediately) {
    preActivationCleanupIntervalHandle = setInterval(() => {
      removeSpansIfNecessary();
    }, transmissionDelay);
    preActivationCleanupIntervalHandle.unref();
  }

  maxKeepAliveUntilSpanBufferIsEmpty = config.tracing.maxKeepAliveUntilSpanBufferIsEmpty;
};

exports.activate = function activate() {
  if (!downstreamConnection) {
    logger.error('No downstreamConnection has been set.');
    return;
  }
  if (!downstreamConnection.sendSpans) {
    logger.error('Configured downstreamConnection has no attribute "sendSpans".');
    return;
  }
  if (typeof downstreamConnection.sendSpans !== 'function') {
    logger.error('downstreamConnection.sendSpans is not a function.');
    return;
  }
  isActive = true;
  if (activatedAt == null) {
    // record the time stamp of the first activation to enforce one second delay between sending snapshot data and
    // sending spans for the first time.
    activatedAt = Date.now();
  }
  spans = [];
  batchingBuckets.clear();
  transmissionTimeoutHandle = setTimeout(transmitSpans, initialDelayBeforeSendingSpans);
  transmissionTimeoutHandle.unref();
  if (preActivationCleanupIntervalHandle) {
    clearInterval(preActivationCleanupIntervalHandle);
  }
};

exports.deactivate = function deactivate() {
  isActive = false;
  spans = [];
  batchingBuckets.clear();
  clearTimeout(transmissionTimeoutHandle);
};

exports.enableSpanBatching = function enableSpanBatching() {
  batchingEnabled = true;
};

exports.addBatchableSpanName = function(spanName) {
  if (!batchableSpanNames.includes(spanName)) {
    batchableSpanNames.push(spanName);
  }
};

exports.addSpan = function(span) {
  if (!isActive) {
    return;
  }

  if (span.t == null) {
    logger.warn('Span of type %s has no trace ID. Not transmitting this span', span.n);
    return;
  }

  const spanIsBatchable = batchingEnabled && isBatchable(span);

  if (!spanIsBatchable || !addToBatch(span)) {
    // add span to span buffer, it will be sent downstream with the next transmission
    spans.push(span);

    if (spanIsBatchable) {
      addToBucket(span);
    }

    if (spans.length >= forceTransmissionStartingAt && Date.now() - minDelayBeforeSendingSpans > activatedAt) {
      transmitSpans();
    }

    if (maxKeepAliveUntilSpanBufferIsEmpty > 0 && keepEphemeralProcessAliveHandle == null) {
      triggerEphemeralProcessKeepAliveTimeout();
    }
  }
};

function addToBatch(span) {
  if (!batchingBuckets.has(span.t)) {
    // If we do not yet have any spans for this trace, we cannot batch anything either.
    return false;
  }

  // A potential partner span for batching can be in the bucket this span would land in or in one of the neighbouring
  // buckets. Theoretically the spans could come in out of order but for performance reason we only support the most
  // common case: The span that ended later (according to span.ts + span.d) is also added to the span buffer later. Thus
  // we check the span's own bucket and the previous bucket.
  const bucketsForTrace = batchingBuckets.get(span.t);
  const key = batchingBucketKey(span);
  const hasBeenBatched = findBatchPartnerAndMerge(span, bucketsForTrace, key);
  if (hasBeenBatched) {
    return true;
  }
  const previousKey = key - batchBucketWidth;
  return findBatchPartnerAndMerge(span, bucketsForTrace, previousKey);
}

function findBatchPartnerAndMerge(newSpan, bucketsForTrace, bucketKey) {
  const bucket = bucketsForTrace.get(bucketKey);
  if (!bucket) {
    // We have not seen any spans for that bucket yet.
    return false;
  }

  for (let i = 0; i < bucket.length; i++) {
    const bufferedSpan = bucket[i];
    // Note: We do not need to check the span.d < 10 ms condition here because only short spans are added to the buckets
    // in the first place.
    if (
      // Only merge spans from the same trace,
      bufferedSpan.t === newSpan.t &&
      // with the same parent,
      bufferedSpan.p === newSpan.p &&
      // and the same type,
      bufferedSpan.n === newSpan.n &&
      // with a gap of less than 10 ms in between.
      (newSpan.ts >= bufferedSpan.ts
        ? newSpan.ts < bufferedSpan.ts + bufferedSpan.d + batchThreshold
        : bufferedSpan.ts < newSpan.ts + newSpan.d + batchThreshold)
    ) {
      mergeSpansAsBatch(bufferedSpan, newSpan, bucket, bucketKey, i);
      return true;
    }
  }

  return false;
}

function mergeSpansAsBatch(oldSpan, newSpan, bucket, bucketKey, indexInBucket) {
  // Determine, if the new span (about to be added to the buffer) is more significant than the old span that is already
  // in the buffer. Determine significance by:
  // 1. span.ec (higher wins)
  // 2. duration (higher wins)
  // 3. start time (earlier wins)
  let mustSwap;
  if (newSpan.ec > oldSpan.ec) {
    mustSwap = true;
  } else if (newSpan.ec === oldSpan.ec && newSpan.d > oldSpan.d) {
    mustSwap = true;
  } else if (newSpan.ec === oldSpan.ec && newSpan.d === oldSpan.d && newSpan.ts < oldSpan.ts) {
    mustSwap = true;
  }

  if (mustSwap) {
    // The new span is more significant, put the new span into the span buffer and merge the old span into it.
    const indexInSpanBuffer = spans.indexOf(oldSpan);
    if (indexInSpanBuffer >= 0) {
      spans[indexInSpanBuffer] = newSpan;
    }
    bucket[indexInBucket] = newSpan;
    mergeIntoTargetSpan(newSpan, oldSpan, bucketKey);
  } else {
    // The old span is at least as significant as the new span, keep it in the span buffer and merge the
    // new span into it.
    mergeIntoTargetSpan(oldSpan, newSpan, bucketKey);
  }
}

/*
 * Merges the source span into the target span. Assumes that target is already in the spanBuffer and source can be
 * discarded afterwards.
 */
function mergeIntoTargetSpan(target, source, originalBucketKey) {
  target.b = target.b || {};

  // Sum durations into span.b.d (batch duration). If one or both spans already are batched (and have a batch duration),
  // prefer that value over the span duration.
  if (target.b.d != null && source.b && source.b.d != null) {
    target.b.d += source.b.d;
  } else if (target.b.d != null) {
    target.b.d += source.d;
  } else if (source.b && source.b.d != null) {
    target.b.d = target.d + source.b.d;
  } else {
    target.b.d = target.d + source.d;
  }

  // Calculate latest end timestamp.
  const latestEnd = Math.max(target.ts + target.d, source.ts + source.d);

  // The batched span starts at the earliest timestamp.
  target.ts = Math.min(target.ts, source.ts);

  // Set duration of merged span to the distance between earliest start timestamp and latest end timestamp.
  target.d = latestEnd - target.ts;

  // Sum up error count.
  target.ec += source.ec;

  setBatchSize(target, source);

  // After changing span.ts and span.d we might need to put the span into an additional bucket.
  const newBucketKey = batchingBucketKey(target);
  if (originalBucketKey !== newBucketKey) {
    addToBucket(target, newBucketKey);
  }
}

function setBatchSize(target, source) {
  if (target.b && target.b.s && source.b && source.b.s) {
    // Both spans already have a batch size, add them up. Note: It is rare that source already has batch properties,
    // but it can happen, for example because of batching of redis multi calls/batch calls directly in the redis
    // instrumentation.
    target.b.s += source.b.s;
    return;
  } else if (target.b && target.b.s) {
    // The old span has a batch size but the new one hasn't, simply increment by one.
    target.b.s += 1;
    return;
  }

  if (source.b && source.b.s) {
    // Only the new span has a batch size,
    target.b.s = source.b.s + 1;
  } else {
    target.b.s = 2;
  }
}

function addToBucket(span, preComputedBucketKey) {
  // Put batcheable spans from the same trace into time-based buckets so we can find them for batching when more
  // spans are added later.
  const bucketKey = preComputedBucketKey || batchingBucketKey(span);
  if (!batchingBuckets.has(span.t)) {
    batchingBuckets.set(span.t, new Map());
  }
  if (!batchingBuckets.get(span.t).has(bucketKey)) {
    batchingBuckets.get(span.t).set(bucketKey, []);
  }
  batchingBuckets
    .get(span.t)
    .get(bucketKey)
    .push(span);
}

function batchingBucketKey(span) {
  const spanEnd = span.ts + span.d;
  return spanEnd - (spanEnd % batchBucketWidth);
}

function isBatchable(span) {
  return (
    // Only batch spans shorter than 10 ms.
    span.d < batchThreshold &&
    // Only batch spans which have a parent (cannot batch a root span).
    span.p &&
    // Only batch spans which are batchable in principle because it is guaranteed to be a leave in the trace tree.
    batchableSpanNames.includes(span.n)
  );
}

function transmitSpans() {
  clearTimeout(transmissionTimeoutHandle);

  if (spans.length === 0) {
    transmissionTimeoutHandle = setTimeout(transmitSpans, transmissionDelay);
    transmissionTimeoutHandle.unref();
    return;
  }

  const spansToSend = spans;
  spans = [];
  spanRequestInFlight = true;
  batchingBuckets.clear();
  // We restore the content of the spans array if sending them downstream was not successful. We do not restore
  // batchingBuckets, though. This is deliberate. In the worst case, we might miss some batching opportunities, but
  // since sending spans downstream will take a few milliseconds, even that will be rare (and it is acceptable).

  downstreamConnection.sendSpans(spansToSend, function sendSpans(error) {
    if (error) {
      logger.warn(`Failed to transmit spans, will retry in ${transmissionDelay} ms.`, error.message);
      spans = spans.concat(spansToSend);
      removeSpansIfNecessary();
    }
    spanRequestInFlight = false;

    transmissionTimeoutHandle = setTimeout(transmitSpans, transmissionDelay);
    transmissionTimeoutHandle.unref();
  });
}

/**
 * Starts a keep alive loop to improve the chances that we can offload all spans to the agent for an ephemeral process.
 */
function triggerEphemeralProcessKeepAliveTimeout() {
  const startedAt = Date.now();
  keepEphemeralProcessAliveHandle = setTimeout(() => waitForEmptySpanBuffer(startedAt), keepAliveCheckDelay);
}

function waitForEmptySpanBuffer(startedAt) {
  if (Date.now() - maxKeepAliveUntilSpanBufferIsEmpty > startedAt) {
    // We waited for the buffer to become empty (that is, for all spans being offloaded to the agent) but now the max
    // waiting time has been reached, so we stop waiting (by not triggering waitForEmptySpanBuffer again).
    keepEphemeralProcessAliveHandle = null;
    return;
  }

  if (spanRequestInFlight) {
    // While a span request is in flight, the isEmpty() check is not valid, because we reset the spans array to an empty
    // array before the request is started, and only put the spans back into the buffer if we find out that we could not
    // successfully send them to the agent. Thus, we just skip this check and schedule the next check.
    keepEphemeralProcessAliveHandle = setTimeout(() => waitForEmptySpanBuffer(startedAt), keepAliveCheckDelay);
  } else if (exports.isEmpty()) {
    // We waited for the buffer to become empty (that is, for all spans being offloaded to the agent) and that has
    // happened now.
    keepEphemeralProcessAliveHandle = null;
  } else {
    // The span buffer is not empty yet but we also have not waited the maximum wait time; schedule the next check.
    keepEphemeralProcessAliveHandle = setTimeout(() => waitForEmptySpanBuffer(startedAt), keepAliveCheckDelay);
  }
}

/**
 * Synchronously returns the spans that are scheduled for transmission and resets the internal span buffer to an empty
 * array.
 */
exports.getAndResetSpans = function getAndResetSpans() {
  const spansToSend = spans;
  spans = [];
  batchingBuckets.clear();
  return spansToSend;
};

exports.isEmpty = function isEmpty() {
  return spans.length === 0;
};

function removeSpansIfNecessary() {
  if (spans.length > maxBufferedSpans) {
    const droppedCount = spans.length - maxBufferedSpans;
    logger.warn(`Span buffer is over capacity, dropping ${droppedCount} spans.`);
    tracingMetrics.incrementDropped(spans.length - maxBufferedSpans);
    // retain the last maxBufferedSpans elements, drop everything before that
    spans = spans.slice(-maxBufferedSpans);
  }
}
