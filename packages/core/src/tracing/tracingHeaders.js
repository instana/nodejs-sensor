/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2020
 */

'use strict';

const constants = require('./constants');
const { generateRandomSpanId, generateRandomTraceId, readAttribCaseInsensitive } = require('./tracingUtil');
const w3c = require('./w3c_trace_context');

let disableW3cTraceCorrelation = false;

/**
 * @param {import('../util/normalizeConfig').InstanaConfig} config
 */
exports.init = function (config) {
  disableW3cTraceCorrelation = config.tracing.disableW3cTraceCorrelation;
};

/**
 * The functions in this module return an object literal with the following shape:
 *
 * @typedef {Object} TracingHeaders
 * @property {string} [traceId] the trace ID:
 *     - will be used for span.t
 *     - will be used for propagating X-INSTANA-T downstream
 *     - will be used for the trace ID part when propagating traceparent downstream
 * @property {string} [longTraceId]
 *     - the full trace ID, when limiting a 128 bit trace ID to 64 bit has occured
 *     - when no limiting has been applied, this is unset
 *     - will be used for span.lt
 * @property {boolean} usedTraceParent
 *     - true if and only if trace ID and parent ID have been taken from the traceparent head (instead of being either
 *       taken from X-INSTAN-T/X-INSTANA-S or having been generated).
 * @property {string} [parentId]
 *     - the parent span ID
 *     - will be used for span.p
 *     - can be null, when this is a the root entry span of a new trace
 * @property {string} level
 *     - the tracing level, either '1' (tracing) or '0' (suppressing/not creating spans)
 *     - progated downstream as the first component of X-INSTANA-L
 *     - propagted downstream as the sampled flag in traceparent
 * @property {string} [correlationType]
 *     - the correlation type parsed from X-INSTANA-L
 *     - will be used for span.crtp
 *     - will not be propagated downstream
 * @property {string} [correlationId]
 *     - the correlation ID parsed from X-INSTANA-L
 *     - will be used for span.crid
 *     - will not be propagated downstream
 * @property {boolean} synthetic
 *     - true if and only if X-INSTANA-SYNTHETIC=1 was present
 *     - will be used for span.sy
 *     - will not be propagated downstream
 * @property {InstanaAncestor} [instanaAncestor]
 *     - only captured when no X-INSTANA-T/S were incoming, but traceparent plus tracestate with an "in" key-value pair
 *       were present in the incoming request
 *     - will be used as span.ia when present
 * @property {import('./w3c_trace_context/W3cTraceContext')} w3cTraceContext
 *     - the W3C trace context information that was extracted from the incoming request headers traceparent and
 *       tracestate or a newly created W3C trace context if those headers were not present or invalid
 *     - will be used to initialize the internal representation of the incoming traceparent/tracestate
 *     - will be used to manipulate that internal representation according to the W3C trace context spec when creating
 *       new child spans and propagating W3C trace context headers downstream
 *     - see ./w3c_trace_context/W3cTraceContext for documentation of attributes
 */

/**
 * @typedef {Object} InstanaAncestor
 * @property {string} t the trace ID from tracestate "in" key-value pair, that is, the trace ID of the closest ancestor
 * span in the trace tree that has been created by an Instana tracer
 * @property {string} p the parent span ID from tracestate "in" key-value pair, that is, the span ID of the closest
 * ancestor in the trace tree that has been created by an Instana tracer
 */

/**
 * Inspects the headers of an incoming HTTP request for X-INSTANA-T, X-INSTANA-S, X-INSTANA-L, as well as the W3C trace
 * context headers traceparent and tracestate.
 * @param {import('http').IncomingMessage} req
 * @returns {TracingHeaders}
 */
exports.fromHttpRequest = function fromHttpRequest(req) {
  if (!req || !req.headers) {
    // @ts-ignore
    req = { headers: {} };
  }
  return exports.fromHeaders(req.headers);
};

/**
 * Inspects the given headers for X-INSTANA-T, X-INSTANA-S, X-INSTANA-L, as well as the W3C trace
 * context headers traceparent and tracestate.
 * @param {import('http').IncomingHttpHeaders} headers
 * @returns {TracingHeaders}
 */
exports.fromHeaders = function fromHeaders(headers) {
  let xInstanaT = readInstanaTraceId(headers);
  let xInstanaS = readInstanaParentId(headers);
  const levelAndCorrelation = readLevelAndCorrelation(headers);
  const level = levelAndCorrelation.level;
  let correlationType = levelAndCorrelation.correlationType;
  let correlationId = levelAndCorrelation.correlationId;
  const synthetic = readSyntheticMarker(headers);
  let w3cTraceContext = readW3cTraceContext(headers);

  if (isSuppressed(level)) {
    // Ignore X-INSTANA-T/-S if X-INSTANA-L: 0 is also present.
    xInstanaT = null;
    xInstanaS = null;
    // Also discard correlation info when level is 0.
    correlationType = null;
    correlationId = null;
  }

  if (correlationType && correlationId) {
    // Ignore X-INSTANA-T/-S and force starting a new span if we received correlation info.
    xInstanaT = null;
    xInstanaS = null;
  }

  if (xInstanaT && xInstanaS && w3cTraceContext) {
    // X-INSTANA- headers *and* W3C trace context headers are present. We use the X-NSTANA- values for tracing and also
    // keep the received W3C trace context around.
    const result = {
      traceId: /** @type {string} */ (xInstanaT),
      parentId: /** @type {string} */ (xInstanaS),
      usedTraceParent: false,
      level,
      correlationType,
      correlationId,
      synthetic,
      w3cTraceContext
    };
    return limitTraceId(result);
  } else if (xInstanaT && xInstanaS) {
    // X-INSTANA- headers are present but W3C trace context headers are not. Use the received IDs and also create a W3C
    // trace context based on those IDs.
    return limitTraceId({
      traceId: /** @type {string} */ (xInstanaT),
      parentId: /** @type {string} */ (xInstanaS),
      usedTraceParent: false,
      level,
      correlationType,
      correlationId,
      synthetic,
      w3cTraceContext: w3c.create(
        /** @type {string} */ (xInstanaT),
        /** @type {string} */ (xInstanaS),
        !isSuppressed(level)
      )
    });
  } else if (w3cTraceContext && !disableW3cTraceCorrelation) {
    // There are no X-INSTANA- headers, but there are W3C trace context headers. As of 2021-02, we use the IDs from
    // traceparent (previously, we would rely on the `in` key value pair or, if that is not present, start a new
    // Instana trace by generating a trace ID).
    // If w3cTraceContext has no instanaTraceId/instanaParentId yet, it will get one as soon as we start a span and
    // upate it. In case we received X-INSTANA-L: 0 we will not start a span, but we will make sure to toggle the
    // sampled flag in traceparent off.
    let instanaAncestor;
    if (traceStateHasInstanaKeyValuePair(w3cTraceContext) && !isSuppressed(level)) {
      instanaAncestor = {
        t: w3cTraceContext.instanaTraceId,
        p: w3cTraceContext.instanaParentId
      };
    }
    return limitTraceId({
      traceId: !isSuppressed(level) ? w3cTraceContext.traceParentTraceId : null,
      parentId: !isSuppressed(level) ? w3cTraceContext.traceParentParentId : null,
      usedTraceParent: !isSuppressed(level),
      level,
      correlationType,
      correlationId,
      synthetic,
      w3cTraceContext,
      instanaAncestor
    });
  } else if (w3cTraceContext) {
    // There are no X-INSTANA- headers, but there are W3C trace context headers. But picking up the trace context from
    // traceparent is disabled via config. We either pick up the trace context from tracestate/in (if present) or start
    // a new trace. Picking up the trace context from tracestate/in is usually not done, it only happens in this legacy
    // mode.
    let traceId = null;
    let parentId = null;
    if (traceStateHasInstanaKeyValuePair(w3cTraceContext) && !isSuppressed(level)) {
      traceId = w3cTraceContext.instanaTraceId;
      parentId = w3cTraceContext.instanaParentId;
    }
    if (!traceId || !parentId) {
      // No X-INSTANA- headers, using traceparent is disabled and there was also no in key-value pair in tracestate,
      // thus we start a new trace.
      traceId = generateRandomTraceId();
      parentId = null;
    }
    return limitTraceId({
      traceId,
      parentId,
      usedTraceParent: false,
      level,
      correlationType,
      correlationId,
      synthetic,
      w3cTraceContext
    });
  } else {
    // Neither X-INSTANA- headers nor W3C trace context headers are present.
    // eslint-disable-next-line no-lonely-if
    if (isSuppressed(level)) {
      // If tracing is suppressed and no headers are incoming, we need to create new random trace and parent IDs (and
      // pass them down in the traceparent header); this trace and parent IDs ares not actually associated with any
      // existing span (Instana or foreign). This can't be helped, the spec mandates to always set the traceparent
      // header on outgoing requests, even if we didn't sample and it has to have a parent ID field.
      return limitTraceId({
        usedTraceParent: false,
        level,
        synthetic,
        w3cTraceContext: w3c.createEmptyUnsampled(generateRandomTraceId(), generateRandomSpanId())
      });
    } else {
      // Neither X-INSTANA- headers nor W3C trace context headers are present and tracing is not suppressed
      // via X-INSTANA-L. Start a new trace, that is, generate a trace ID and use it for for our trace ID as well as in
      // the W3C trace context.
      xInstanaT = generateRandomTraceId();
      // We create a new dummy W3C trace context with an invalid parent ID, as we have no parent ID yet. Later, in
      // cls.startSpan, we will update it so it gets the parent ID of the entry span we create there. The bogus
      // parent ID "000..." will never be transmitted to any other service.
      w3cTraceContext = w3c.create(xInstanaT, '0000000000000000', true);
      return limitTraceId({
        traceId: xInstanaT,
        parentId: null,
        usedTraceParent: false,
        level,
        correlationType,
        correlationId,
        synthetic,
        w3cTraceContext
      });
    }
  }
};

/**
 * @param {import('http').IncomingHttpHeaders} headers
 * @returns {string | Array.<string>}
 */
function readInstanaTraceId(headers) {
  const xInstanaT = readAttribCaseInsensitive(headers, constants.traceIdHeaderNameLowerCase);
  if (xInstanaT == null) {
    return null;
  }
  return xInstanaT;
}

/**
 * @param {import('http').IncomingHttpHeaders} headers
 * @returns {string | Array.<string>}
 */
function readInstanaParentId(headers) {
  const xInstanaS = readAttribCaseInsensitive(headers, constants.spanIdHeaderNameLowerCase);
  if (xInstanaS == null) {
    return null;
  }
  return xInstanaS;
}

/**
 * @param {import('http').IncomingHttpHeaders} headers
 */
function readLevelAndCorrelation(headers) {
  const xInstanaL = readAttribCaseInsensitive(headers, constants.traceLevelHeaderNameLowerCase);
  if (xInstanaL == null) {
    // fast path for when we did not receive the header at all
    return {};
  }
  if (xInstanaL.length === 1 && (xInstanaL === '0' || xInstanaL === '1')) {
    // fast path for valid header without correlation information
    return { level: xInstanaL };
  } else if (xInstanaL.length === 1) {
    // invalid value, ignore
    return {};
  }

  let level = xInstanaL[0];
  let correlationType = null;
  let correlationId = null;
  if (level !== '0' && level !== '1') {
    level = null;
  }

  const parts = /** @type {string} */ (xInstanaL).split(',');
  if (parts.length > 1) {
    const idxType = parts[1].indexOf('correlationType=');
    const idxSemi = parts[1].indexOf(';');
    const idxId = parts[1].indexOf('correlationId=');
    if (idxType >= 0 && idxSemi > 0 && idxId > 0) {
      correlationType = parts[1].substring(idxType + 16, idxSemi);
      if (correlationType) {
        correlationType = correlationType.trim();
      }
      correlationId = parts[1].substring(idxId + 14);
      if (correlationId) {
        correlationId = correlationId.trim();
      }
    }
  }
  return {
    level,
    correlationType,
    correlationId
  };
}

/**
 * @param {string | undefined} level
 * @returns {boolean}
 */
function isSuppressed(level) {
  return typeof level === 'string' && level.indexOf('0') === 0;
}

/**
 * @param {import('http').IncomingHttpHeaders} headers
 */
function readSyntheticMarker(headers) {
  return readAttribCaseInsensitive(headers, constants.syntheticHeaderNameLowerCase) === '1';
}

/**
 * @param {import('./w3c_trace_context/W3cTraceContext')} w3cTraceContext
 * @returns {boolean}
 */
function traceStateHasInstanaKeyValuePair(w3cTraceContext) {
  return !!(w3cTraceContext.instanaTraceId && w3cTraceContext.instanaParentId);
}

/**
 * @param {import('http').IncomingHttpHeaders} headers
 */
function readW3cTraceContext(headers) {
  const traceParent = /** @type {string} */ (readAttribCaseInsensitive(headers, constants.w3cTraceParent));
  // The spec mandates that multiple tracestate headers should be treated by concatenating them. Node.js' http core
  // library takes care of that already.
  const traceState = /** @type {string} */ (readAttribCaseInsensitive(headers, constants.w3cTraceState));
  let traceContext;
  if (traceParent) {
    traceContext = w3c.parse(traceParent, traceState);
  }

  if (traceContext) {
    if (!traceContext.traceParentValid) {
      traceContext = null;
    } else if (!traceContext.traceStateValid) {
      traceContext.resetTraceState();
    }
  }

  return traceContext;
}

/**
 * @param {TracingHeaders} result
 * @returns {TracingHeaders}
 */
function limitTraceId(result) {
  if (result.traceId && result.traceId.length >= 32) {
    result.longTraceId = result.traceId;
    result.traceId = result.traceId.substring(16, 32);
  }
  return result;
}

/**
 * Takes the result of fromHttpReques/fromHeaders and sets the required attributes on the span.
 * @param {import('./cls').InstanaBaseSpan} span
 * @param {TracingHeaders} tracingHeaders
 */
exports.setSpanAttributes = function (span, tracingHeaders) {
  if (tracingHeaders.correlationType && tracingHeaders.correlationId) {
    span.crtp = tracingHeaders.correlationType;
    span.crid = tracingHeaders.correlationId;
  }
  if (tracingHeaders.instanaAncestor) {
    span.ia = tracingHeaders.instanaAncestor;
  }
  if (tracingHeaders.longTraceId) {
    span.lt = tracingHeaders.longTraceId;
  }
  if (tracingHeaders.usedTraceParent) {
    span.tp = true;
  }
  if (tracingHeaders.synthetic) {
    span.sy = true;
  }
};
