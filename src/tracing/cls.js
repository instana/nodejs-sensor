'use strict';

var tracingUtil = require('./tracingUtil');
var hooked = require('cls-hooked');
var currentSpanKey = 'csKey';

/*
 * Access the Instana namespace in context local storage.
 *
 * Usage:
 *   cls.ns.get(key);
 *   cls.ns.set(key);
 *   cls.ns.run(function() {});
 *
 */
var instanaNamespace = 'instana.sensor';
Object.defineProperty(exports, 'ns', {
  get: function() {
    return hooked.getNamespace(instanaNamespace) || hooked.createNamespace(instanaNamespace);
  }
});

/*
 * Start a new span and set it as the current span
 *
 */
exports.startSpan = function startSpan(spanName, traceId, spanId) {
  var span = {
    f: tracingUtil.getFrom(),
    async: false,
    error: false,
    ec: 0,
    ts: Date.now(),
    d: 0,
    n: spanName,
    stack: [],
    data: null
  };

  var parentSpan = exports.ns.get(currentSpanKey);
  var randomId = tracingUtil.generateRandomSpanId();

  // If specified, use params
  if (traceId && spanId) {
    span.t = traceId;
    span.p = spanId;
  // else use pre-existing context (if any)
  } else if (parentSpan) {
    span.t = parentSpan.t;
    span.p = parentSpan.s;
  // last resort, use newly generated Ids
  } else {
    span.t = randomId;
  }
  span.s = randomId;
  exports.ns.set(currentSpanKey, span);
  return span;
};

/*
 * Get the currently active span
 *
 */
exports.getCurrentSpan = function getCurrentSpan() {
  return exports.ns.get(currentSpanKey);
};

/*
 * Determine if we're currently tracing or not.
 *
 */
exports.isTracing = function isTracing() {
  return exports.ns.get(currentSpanKey) ? true : false;
};

/*
 * Set the tracing level
 */
var tracingLevelKey = 'tlKey';
exports.setTracingLevel = function setTracingLevel(level) {
  return exports.ns.set(tracingLevelKey, level);
};

/*
 * Get the tracing level (if any)
 */
exports.tracingLevel = function tracingLevel() {
  return exports.ns.get(tracingLevelKey);
};

/*
 * Determine if tracing is suppressed (via tracing level) for this request.
 *
 */
exports.tracingSuppressed = function tracingSuppressed() {
  var tl = exports.ns.get(tracingLevelKey);
  if (tl && tl === '0') {
    return true;
  }
  return false;
};

/*
 * Determine if <span> is an exit span
 *
 */
var exitSpans = ['node.http.client', 'elasticsearch', 'mongo', 'mysql'];
exports.isExitSpan = function isExitSpan(span) {
  return (exitSpans.indexOf(span.n) > -1);
};
