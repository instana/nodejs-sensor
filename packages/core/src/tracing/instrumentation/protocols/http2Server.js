'use strict';

var semver = require('semver');

var cls = require('../../cls');
var constants = require('../../constants');
var httpCommon = require('./_http');
var readSymbolProperty = require('../../../util/readSymbolProperty');
var shimmer = require('shimmer');
var tracingHeaders = require('../../tracingHeaders');
var urlUtil = require('../../../util/url');

var discardUrlParameters = urlUtil.discardUrlParameters;
var filterParams = urlUtil.filterParams;

var extraHttpHeadersToCapture;
var isActive = false;

exports.spanName = 'node.http.server';

var sentHeadersS = 'Symbol(sent-headers)';
var HTTP2_HEADER_AUTHORITY;
var HTTP2_HEADER_METHOD;
var HTTP2_HEADER_PATH;
var HTTP2_HEADER_STATUS;

exports.init = function(config) {
  if (semver.gte(process.versions.node, '8.4.0')) {
    var http2 = require('http2');
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
  var original = coreModule[name];
  coreModule[name] = function createHttp2Server() {
    var server = original.apply(this, arguments);
    shimmer.wrap(server, 'emit', shimEmit);
    return server;
  };
}

function shimEmit(realEmit) {
  return function(eventType, stream, headers) {
    if (eventType !== 'stream' || !isActive) {
      return realEmit.apply(this, arguments);
    }

    var originalThis = this;
    var originalArgs = arguments;

    return cls.ns.runAndReturn(function() {
      if (stream && stream.on && stream.addListener && stream.emit) {
        cls.ns.bindEmitter(stream);
      }

      var processedHeaders = tracingHeaders.fromHeaders(headers);
      var w3cTraceContext = processedHeaders.w3cTraceContext;

      if (typeof processedHeaders.level === 'string' && processedHeaders.level.indexOf('0') === 0) {
        cls.setTracingLevel('0');
        if (w3cTraceContext) {
          w3cTraceContext.disableSampling();
        }
      }

      if (w3cTraceContext) {
        // Ususally we commit the W3C trace context to CLS in start span, but in some cases (e.g. when suppressed),
        // we don't call startSpan, so we write to CLS here unconditionally. If we also write an update trace context
        // later, the one written here will be overwritten.
        cls.setW3cTraceContext(w3cTraceContext);
      }

      if (cls.tracingSuppressed()) {
        // We still need to forward X-INSTANA-L and the W3C trace context; this happens in exit instrumentations
        // (like httpClient.js).
        return realEmit.apply(originalThis, originalArgs);
      }

      var span = cls.startSpan(
        exports.spanName,
        constants.ENTRY,
        processedHeaders.traceId,
        processedHeaders.parentId,
        w3cTraceContext
      );

      if (processedHeaders.correlationType && processedHeaders.correlationId) {
        span.data.correlationType = processedHeaders.correlationType;
        span.data.correlationId = processedHeaders.correlationId;
      }
      if (processedHeaders.foreignParent) {
        span.fp = processedHeaders.foreignParent;
      }
      if (processedHeaders.synthetic) {
        span.sy = true;
      }

      var authority = headers[HTTP2_HEADER_AUTHORITY];
      var path = headers[HTTP2_HEADER_PATH] || '/';
      var method = headers[HTTP2_HEADER_METHOD] || 'GET';

      var pathParts = path.split('?');
      if (pathParts.length >= 2) {
        pathParts[1] = filterParams(pathParts[1]);
      }

      span.data.http = {
        method: method,
        url: discardUrlParameters(pathParts.shift()),
        params: pathParts.length > 0 ? pathParts.join('?') : undefined,
        host: authority,
        header: httpCommon.getExtraHeadersCaseInsensitive(headers, extraHttpHeadersToCapture)
      };

      stream.on('aborted', function() {
        finishSpan();
      });

      stream.on('close', function() {
        finishSpan();
      });

      // Deliberately not listening for end as that event is sometimes called before all headers have been written.

      function finishSpan() {
        // Check if a span with higher priority (like graphql.server) already finished this span, only overwrite
        // span attributes if that is not the case.
        if (!span.transmitted) {
          var status;
          var resHeaders = readSymbolProperty(stream, sentHeadersS);
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

exports.updateConfig = function(config) {
  extraHttpHeadersToCapture = config.tracing.http.extraHttpHeadersToCapture;
};

exports.activate = function() {
  isActive = true;
};

exports.deactivate = function() {
  isActive = false;
};

exports.setExtraHttpHeadersToCapture = function setExtraHttpHeadersToCapture(_extraHeaders) {
  extraHttpHeadersToCapture = _extraHeaders;
};