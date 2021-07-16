/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2016
 */

'use strict';

const coreHttpsModule = require('https');
const coreHttpModule = require('http');

const constants = require('../../constants');
const tracingHeaders = require('../../tracingHeaders');
const { filterParams, sanitizeUrl } = require('../../../util/url');
const httpCommon = require('./_http');
const shimmer = require('shimmer');
const cls = require('../../cls');

let extraHttpHeadersToCapture;
let isActive = false;

exports.spanName = 'node.http.server';

exports.init = function init(config) {
  shimmer.wrap(coreHttpModule.Server && coreHttpModule.Server.prototype, 'emit', shimEmit);
  shimmer.wrap(coreHttpsModule.Server && coreHttpsModule.Server.prototype, 'emit', shimEmit);
  extraHttpHeadersToCapture = config.tracing.http.extraHttpHeadersToCapture;
};

exports.updateConfig = function updateConfig(config) {
  extraHttpHeadersToCapture = config.tracing.http.extraHttpHeadersToCapture;
};

function shimEmit(realEmit) {
  return function (type, req, res) {
    if (type !== 'request' || !isActive) {
      return realEmit.apply(this, arguments);
    }

    const originalThis = this;
    const originalArgs = arguments;

    return cls.ns.runAndReturn(() => {
      if (req && req.on && req.addListener && req.emit) {
        cls.ns.bindEmitter(req);
      }
      if (res && res.on && res.addListener && res.emit) {
        cls.ns.bindEmitter(res);
      }

      const headers = tracingHeaders.fromHttpRequest(req);
      const w3cTraceContext = headers.w3cTraceContext;

      if (typeof headers.level === 'string' && headers.level.indexOf('0') === 0) {
        cls.setTracingLevel('0');
        if (w3cTraceContext) {
          w3cTraceContext.disableSampling();
        }
      }

      if (w3cTraceContext) {
        // Ususally we commit the W3C trace context to CLS in start span, but in some cases (e.g. when suppressed),
        // we don't call startSpan, so we write to CLS here unconditionally. If we also write an updated trace context
        // later, the one written here will be overwritten.
        cls.setW3cTraceContext(w3cTraceContext);
      }

      if (cls.tracingSuppressed()) {
        // We still need to forward X-INSTANA-L and the W3C trace context; this happens in exit instrumentations
        // (like httpClient.js).
        return realEmit.apply(originalThis, originalArgs);
      }

      const span = cls.startSpan(exports.spanName, constants.ENTRY, headers.traceId, headers.parentId, w3cTraceContext);
      tracingHeaders.setSpanAttributes(span, headers);

      // Capture the URL before application code gets access to the incoming message. Libraries like express manipulate
      // req.url when routers are used.
      const urlParts = req.url.split('?');
      if (urlParts.length >= 2) {
        urlParts[1] = filterParams(urlParts[1]);
      }
      span.data.http = {
        method: req.method,
        url: sanitizeUrl(urlParts.shift()),
        params: urlParts.length > 0 ? urlParts.join('?') : undefined,
        host: req.headers.host,
        header: httpCommon.getExtraHeadersFromMessage(req, extraHttpHeadersToCapture)
      };

      const incomingServiceName =
        span.data.http.header && span.data.http.header[constants.serviceNameHeaderNameLowerCase];
      if (incomingServiceName != null) {
        span.data.service = incomingServiceName;
      }

      if (!req.headers['x-instana-t']) {
        // In cases where we have started a fresh trace (that is, there is no X-INSTANA-T in the incoming request
        // headers, we add the new trace ID to the incoming request so a customer's app can render it reliably into the
        // EUM snippet, see
        // eslint-disable-next-line max-len
        // https://www.instana.com/docs/products/website_monitoring/backendCorrelation/#retrieve-the-backend-trace-id-in-nodejs
        req.headers['x-instana-t'] = span.t;
      }

      // Support for automatic client/back end EUM correlation: We add our key-value pair to the Server-Timing header
      // (the key intid is short for INstana Trace ID). This abbreviation is small enough to not incur a notable
      // overhead while at the same time being unique enough to avoid name collisions.
      const serverTimingValue = `intid;desc=${span.t}`;
      res.setHeader('Server-Timing', serverTimingValue);
      shimmer.wrap(
        res,
        'setHeader',
        realSetHeader =>
          function shimmedSetHeader(key, value) {
            if (key.toLowerCase() === 'server-timing') {
              if (value == null) {
                return realSetHeader.call(this, key, serverTimingValue);
              } else if (Array.isArray(value)) {
                if (value.find(kv => kv.indexOf('intid;') === 0)) {
                  // If the application code sets intid, do not append another intid value. Actually, the application
                  // has no business setting an intid key-value pair, but it could happen theoretically for a proxy-like
                  // Node.js app (which blindly copies headers from downstream responses) in combination with a
                  // downstream service that is also instrumented by Instana (and adds the intid key-value pair).
                  return realSetHeader.apply(this, arguments);
                } else {
                  return realSetHeader.call(this, key, value.concat(serverTimingValue));
                }
              } else if (typeof value === 'string' && value.indexOf('intid;') >= 0) {
                // Do not add another intid key-value pair, see above.
                return realSetHeader.apply(this, arguments);
              } else {
                return realSetHeader.call(this, key, `${value}, ${serverTimingValue}`);
              }
            }
            return realSetHeader.apply(this, arguments);
          }
      );

      req.on('aborted', () => {
        finishSpan();
      });

      res.on('finish', () => {
        finishSpan();
      });

      res.on('close', () => {
        // This is purely a safe guard: in all known scenarios, one of the other events that finishes the HTTP entry
        // span should have been called before (res#finish or req#aborted).
        finishSpan();
      });

      function finishSpan() {
        // Check if a span with higher priority (like graphql.server) already finished this span, only overwrite
        // span attributes if that is not the case.
        if (!span.transmitted) {
          // safe guard just in case a higher prio instrumentation (graphql etc.) has removed data.http (planning to
          // take over the span) but did not actually transmit this span.
          span.data.http = span.data.http || {};
          span.data.http.status = res.statusCode;
          span.data.http.header = httpCommon.mergeExtraHeadersFromServerResponseOrClientResponse(
            span.data.http.header,
            res,
            extraHttpHeadersToCapture
          );
          span.ec = res.statusCode >= 500 ? 1 : 0;
          span.d = Date.now() - span.ts;
          span.transmit();
        }
      }

      return realEmit.apply(originalThis, originalArgs);
    });
  };
}

exports.activate = function activate() {
  isActive = true;
};

exports.deactivate = function deactivate() {
  isActive = false;
};

exports.setExtraHttpHeadersToCapture = function setExtraHttpHeadersToCapture(_extraHeaders) {
  extraHttpHeadersToCapture = _extraHeaders;
};
