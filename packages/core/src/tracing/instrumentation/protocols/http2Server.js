/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2020
 */

'use strict';

const semver = require('semver');

const cls = require('../../cls');
const constants = require('../../constants');
const httpCommon = require('./_http');
const readSymbolProperty = require('../../../util/readSymbolProperty');
const shimmer = require('shimmer');
const tracingHeaders = require('../../tracingHeaders');
const { filterParams, sanitizeUrl } = require('../../../util/url');

let extraHttpHeadersToCapture;
let isActive = false;

exports.spanName = 'node.http.server';

const sentHeadersS = 'Symbol(sent-headers)';
let HTTP2_HEADER_AUTHORITY;
let HTTP2_HEADER_METHOD;
let HTTP2_HEADER_PATH;
let HTTP2_HEADER_STATUS;

exports.init = function init(config) {
  if (semver.gte(process.versions.node, '8.4.0')) {
    const http2 = require('http2');
    HTTP2_HEADER_AUTHORITY = http2.constants.HTTP2_HEADER_AUTHORITY;
    HTTP2_HEADER_METHOD = http2.constants.HTTP2_HEADER_METHOD;
    HTTP2_HEADER_PATH = http2.constants.HTTP2_HEADER_PATH;
    HTTP2_HEADER_STATUS = http2.constants.HTTP2_HEADER_STATUS;
    instrument(http2);
  }
  extraHttpHeadersToCapture = config.tracing.http.extraHttpHeadersToCapture;
};

function instrument(coreModule) {
  instrumentCreateServer(coreModule, 'createServer');
  instrumentCreateServer(coreModule, 'createSecureServer');
}

function instrumentCreateServer(coreModule, name) {
  const original = coreModule[name];
  coreModule[name] = function createHttp2Server() {
    const server = original.apply(this, arguments);
    shimmer.wrap(server, 'emit', shimEmit);
    return server;
  };
}

function shimEmit(realEmit) {
  return function (eventType, stream, headers) {
    if (eventType !== 'stream' || !isActive) {
      return realEmit.apply(this, arguments);
    }

    const originalThis = this;
    const originalArgs = arguments;

    return cls.ns.runAndReturn(() => {
      if (stream && stream.on && stream.addListener && stream.emit) {
        cls.ns.bindEmitter(stream);
      }

      const processedHeaders = tracingHeaders.fromHeaders(headers);
      const w3cTraceContext = processedHeaders.w3cTraceContext;

      if (typeof processedHeaders.level === 'string' && processedHeaders.level.indexOf('0') === 0) {
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

      const span = cls.startSpan(
        exports.spanName,
        constants.ENTRY,
        processedHeaders.traceId,
        processedHeaders.parentId,
        w3cTraceContext
      );
      tracingHeaders.setSpanAttributes(span, headers);

      const authority = headers[HTTP2_HEADER_AUTHORITY];
      const path = headers[HTTP2_HEADER_PATH] || '/';
      const method = headers[HTTP2_HEADER_METHOD] || 'GET';

      const pathParts = path.split('?');
      if (pathParts.length >= 2) {
        pathParts[1] = filterParams(pathParts[1]);
      }

      span.data.http = {
        method,
        url: sanitizeUrl(pathParts.shift()),
        params: pathParts.length > 0 ? pathParts.join('?') : undefined,
        host: authority,
        header: httpCommon.getExtraHeadersFromHeaders(headers, extraHttpHeadersToCapture)
      };

      const incomingServiceName =
        span.data.http.header && span.data.http.header[constants.serviceNameHeaderNameLowerCase];
      if (incomingServiceName != null) {
        span.data.service = incomingServiceName;
      }

      if (!headers['x-instana-t']) {
        // In cases where we have started a fresh trace (that is, there is no X-INSTANA-T in the incoming request
        // headers, we add the new trace ID to the incoming request so a customer's app can render it reliably into the
        // EUM snippet, see
        // eslint-disable-next-line max-len
        // https://www.instana.com/docs/products/website_monitoring/backendCorrelation/#retrieve-the-backend-trace-id-in-nodejs
        headers['x-instana-t'] = span.t;
      }

      // Support for automatic client/back end EUM correlation: We add our key-value pair to the Server-Timing header
      // (the key intid is short for INstana Trace ID). This abbreviation is small enough to not incur a notable
      // overhead while at the same time being unique enough to avoid name collisions.
      const serverTimingValue = `intid;desc=${span.t}`;
      instrumentResponseMethod(stream, 'respond', 0, serverTimingValue);
      instrumentResponseMethod(stream, 'respondWithFD', 1, serverTimingValue);
      instrumentResponseMethod(stream, 'respondWithFile', 1, serverTimingValue);

      stream.on('aborted', () => {
        finishSpan();
      });

      stream.on('close', () => {
        finishSpan();
      });

      // Deliberately not listening for end as that event is sometimes called before all headers have been written.

      function finishSpan() {
        // Check if a span with higher priority (like graphql.server) already finished this span, only overwrite
        // span attributes if that is not the case.
        if (!span.transmitted) {
          let status;
          const resHeaders = readSymbolProperty(stream, sentHeadersS);
          if (resHeaders) {
            status = resHeaders[HTTP2_HEADER_STATUS];
          }

          // safe guard just in case a higher prio instrumentation (graphql etc.) has removed data.http (planning to
          // take over the span) but did not actually transmit this span.
          span.data.http = span.data.http || {};
          span.data.http.status = status;
          span.data.http.header = httpCommon.mergeExtraHeadersCaseInsensitive(
            span.data.http.header,
            resHeaders,
            extraHttpHeadersToCapture
          );
          span.ec = status >= 500 ? 1 : 0;
          span.d = Date.now() - span.ts;
          span.transmit();
        }
      }

      return realEmit.apply(originalThis, originalArgs);
    });
  };
}

function instrumentResponseMethod(stream, method, headerArgumentIndex, serverTimingValue) {
  if (typeof stream[method] === 'function') {
    shimmer.wrap(
      stream,
      method,
      original =>
        function () {
          const headers = arguments[headerArgumentIndex];
          if (!headers || typeof headers !== 'object' || !headers[HTTP2_HEADER_STATUS]) {
            return original.apply(this, arguments);
          }
          const existingKey = Object.keys(headers).filter(key => key.toLowerCase() === 'server-timing')[0];

          const existingValue = existingKey ? headers[existingKey] : null;
          if (existingValue == null) {
            headers['Server-Timing'] = serverTimingValue;
          } else if (Array.isArray(existingValue)) {
            if (!existingValue.find(kv => kv.indexOf('intid;') === 0)) {
              headers[existingKey] = existingValue.concat(serverTimingValue);
            }
          } else if (typeof existingValue === 'string' && existingValue.indexOf('intid;') < 0) {
            headers[existingKey] = `${existingValue}, ${serverTimingValue}`;
          }
          return original.apply(this, arguments);
        }
    );
  }
}

exports.updateConfig = function updateConfig(config) {
  extraHttpHeadersToCapture = config.tracing.http.extraHttpHeadersToCapture;
};

exports.activate = function activate() {
  isActive = true;
};

exports.deactivate = function deactivate() {
  isActive = false;
};

exports.setExtraHttpHeadersToCapture = function setExtraHttpHeadersToCapture(_extraHeaders) {
  extraHttpHeadersToCapture = _extraHeaders;
};
