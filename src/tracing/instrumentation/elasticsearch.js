'use strict';

var requireHook = require('../../util/requireHook');
var transmission = require('../transmission');
var tracingUtil = require('../tracingUtil');
var cls = require('../cls');

var isActive = false;

exports.init = function() {
  requireHook.on('elasticsearch', instrument);
};

function instrument(es) {
  var OriginalClient = es.Client;

  es.Client = function InstrumentedClient() {
    var client = OriginalClient.apply(OriginalClient, arguments);
    var info = {};

    gatherClusterInfo(client, info);

    instrumentApi(client, 'search', info);
    instrumentApi(client, 'index', info);
    instrumentApi(client, 'get', info);

    return client;
  };
}

function gatherClusterInfo(client, info) {
  client.info()
    .then(function(_info) {
      info.clusterName = _info.cluster_name;
    }, function() {
      setTimeout(function() {
        gatherClusterInfo(client, info);
      }, 30000);
    });
}

function instrumentApi(client, action, info) {
  var original = client[action];

  client[action] = function instrumentedAction(params, cb) {
    cls.stanStorage.run(() => {
      var context = cls.createContext();
      var traceId = context.traceId;

      if (!isActive || context.tracingSuppressed || context.containsExitSpan || traceId == null) {
        return original.apply(client, arguments);
      }

      context.containsExitSpan = true;

      var span = {
        s: tracingUtil.generateRandomSpanId(),
        t: traceId,
        p: context.parentSpanId,
        f: tracingUtil.getFrom(),
        async: false,
        error: false,
        ec: 0,
        ts: Date.now(),
        d: 0,
        n: 'elasticsearch',
        stack: tracingUtil.getStackTrace(instrumentedAction),
        data: {
          elasticsearch: {
            action: action,
            cluster: info.clusterName,
            index: toStringEsMultiParameter(params.index),
            type: toStringEsMultiParameter(params.type),
            stats: toStringEsMultiParameter(params.stats),
            id: action === 'get' ? params.id : undefined,
            query: action === 'search' ? JSON.stringify(params) : undefined
          }
        }
      };
      context.spanId = span.s;

      if (arguments.length === 2) {
        return original.call(client, params, function(error, response) {
          if (error) {
            onError(error);
          } else {
            onSuccess(response);
          }

          return cb.apply(this, arguments);
        });
      }

      try {
        return original.call(client, params)
          .then(onSuccess, function(error) {
            onError(error);
            throw error;
          });
      } catch (e) {
        // Immediately cleanup on synchronous errors.
        cls.destroyContextByUid(context.uid);
        throw e;
      }

      function onSuccess(response) {
        if (response.hits != null && response.hits.total != null) {
          span.data.elasticsearch.hits = response.hits.total;
        }
        span.d = Date.now() - span.ts;
        span.error = false;
        transmission.addSpan(span);
        cls.destroyContextByUid(context.uid);
        return response;
      }

      function onError(error) {
        span.d = Date.now() - span.ts;
        span.error = true;
        span.ec = 1;
        span.data.elasticsearch.error = error.message;
        transmission.addSpan(span);
        cls.destroyContextByUid(context.uid);
      }
    });
  };
}

function toStringEsMultiParameter(param) {
  if (param == null) {
    return undefined;
  }

  if (typeof(param) === 'string') {
    if (param === '') {
      return '_all';
    }
    return param;
  } else if (param instanceof Array) {
    return param.join(',');
  }

  return JSON.stringify(param);
}

exports.activate = function() {
  isActive = true;
};


exports.deactivate = function() {
  isActive = false;
};
