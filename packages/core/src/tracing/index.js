/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2016
 */

'use strict';

const sdk = require('./sdk');
const constants = require('./constants');
const tracingMetrics = require('./metrics');
const opentracing = require('./opentracing');
const spanHandle = require('./spanHandle');
const tracingHeaders = require('./tracingHeaders');
const tracingUtil = require('./tracingUtil');
const spanBuffer = require('./spanBuffer');
const supportedVersion = require('./supportedVersion');

let tracingEnabled = false;
let tracingActivated = false;
let instrumenationsInitialized = false;
let automaticTracingEnabled = false;
/** @type {import('./cls')} */
let cls = null;
/** @type {import('../util/normalizeConfig').InstanaConfig} */
let config = null;
/** @type {Array.<string>} */
let extraHeaders = [];
/** @type {import('../index').ProcessIdentityProvider} */
let processIdentityProvider = null;

// Note: Also update initializedTooLateHeuristic.js and the accompanying test when adding instrumentations.
const instrumentations = [
  './instrumentation/cloud/aws-sdk/v2/index',
  './instrumentation/cloud/aws-sdk/v3/index',
  './instrumentation/cloud/aws-sdk/v2/sdk',
  './instrumentation/cloud/aws-sdk/v2/sqs',
  './instrumentation/cloud/gcp/pubsub',
  './instrumentation/cloud/gcp/storage',
  './instrumentation/control_flow/bluebird',
  './instrumentation/control_flow/graphqlSubscriptions',
  './instrumentation/database/elasticsearchLegacy',
  './instrumentation/database/elasticsearchModern',
  './instrumentation/database/ioredis',
  './instrumentation/database/memcached',
  './instrumentation/database/mongodb',
  './instrumentation/database/mongoose',
  './instrumentation/database/mssql',
  './instrumentation/database/mysql',
  './instrumentation/database/pg',
  './instrumentation/database/pgNative',
  './instrumentation/database/redis',
  './instrumentation/frameworks/express',
  './instrumentation/frameworks/fastify',
  './instrumentation/frameworks/hapi',
  './instrumentation/frameworks/koa',
  './instrumentation/loggers/bunyan',
  './instrumentation/loggers/log4js',
  './instrumentation/loggers/pino',
  './instrumentation/loggers/winston',
  './instrumentation/messaging/amqp',
  './instrumentation/messaging/kafkaJs',
  './instrumentation/messaging/kafkaNode',
  './instrumentation/messaging/nats',
  './instrumentation/messaging/natsStreaming',
  './instrumentation/messaging/bull',
  './instrumentation/process/memored',
  './instrumentation/process/process',
  './instrumentation/protocols/graphql',
  './instrumentation/protocols/grpc',
  './instrumentation/protocols/httpClient',
  './instrumentation/protocols/httpServer',
  './instrumentation/protocols/http2Client',
  './instrumentation/protocols/http2Server',
  './instrumentation/protocols/superagent'
];

/**
 * This is a temporary type definition for instrumented modules until we get to add types to these modules.
 * For now it is safe to say that these modules are objects with the following methods:
 * @typedef {Object} InstanaInstrumentedModule
 * @property {Function} init
 * @property {Function} activate
 * @property {Function} deactivate
 * @property {Function} [updateConfig]
 * @property {(extraHeaders: Array.<*>) => {}} [setExtraHttpHeadersToCapture]
 * @property {boolean} [batchable]
 * @property {string} [spanName]
 */

/** @type {Array.<InstanaInstrumentedModule>} */
let additionalInstrumentationModules = [];
/** @type {Object.<string, InstanaInstrumentedModule>} */
const instrumentationModules = {};

exports.constants = constants;
exports.tracingHeaders = tracingHeaders;
exports.opentracing = opentracing;
exports.sdk = sdk;
exports.spanBuffer = spanBuffer;
exports.supportedVersion = supportedVersion;
exports.util = tracingUtil;

/**
 * @param {Array.<InstanaInstrumentedModule>} _additionalInstrumentationModules
 */
exports.registerAdditionalInstrumentations = function registerAdditionalInstrumentations(
  _additionalInstrumentationModules
) {
  additionalInstrumentationModules = additionalInstrumentationModules.concat(_additionalInstrumentationModules);
};

/**
 * @param {import('../util/normalizeConfig').InstanaConfig} preliminaryConfig
 */
exports.preInit = function preInit(preliminaryConfig) {
  initInstrumenations(preliminaryConfig);
};

/**
 * @param {import('../util/normalizeConfig').InstanaConfig} _config
 * @param {import('./spanBuffer').TemporaryAgentConnection} downstreamConnection
 * @param {import('../index').ProcessIdentityProvider} _processIdentityProvider
 */
exports.init = function init(_config, downstreamConnection, _processIdentityProvider) {
  config = _config;
  processIdentityProvider = _processIdentityProvider;

  tracingEnabled = config.tracing.enabled;
  automaticTracingEnabled = config.tracing.automaticTracingEnabled;

  if (tracingEnabled) {
    tracingUtil.init(config);
    tracingHeaders.init(config);
    spanBuffer.init(config, downstreamConnection);
    opentracing.init(config, automaticTracingEnabled, processIdentityProvider);
    cls = require('./cls');
    cls.init(config, processIdentityProvider);
    sdk.init(cls);

    if (automaticTracingEnabled) {
      initInstrumenations(config);
    }
  }

  if (config.tracing.activateImmediately) {
    exports.activate();
  }
};

/**
 * @param {import('../util/normalizeConfig').InstanaConfig} _config
 */
function initInstrumenations(_config) {
  // initialize all instrumentations
  if (!instrumenationsInitialized) {
    instrumentations.forEach(instrumentationKey => {
      instrumentationModules[instrumentationKey] = require(instrumentationKey);
      instrumentationModules[instrumentationKey].init(_config);
      if (instrumentationModules[instrumentationKey].batchable && instrumentationModules[instrumentationKey].spanName) {
        spanBuffer.addBatchableSpanName(instrumentationModules[instrumentationKey].spanName);
      }
    });
    additionalInstrumentationModules.forEach(instrumentationModule => {
      instrumentationModule.init(_config);
    });
    instrumenationsInitialized = true;
  } else {
    instrumentations.forEach(instrumentationKey => {
      if (instrumentationModules[instrumentationKey].updateConfig) {
        instrumentationModules[instrumentationKey].updateConfig(_config);
      }
    });
  }
}

exports.activate = function activate() {
  if (tracingEnabled && !tracingActivated) {
    tracingActivated = true;
    spanBuffer.activate();
    opentracing.activate();
    sdk.activate();

    if (automaticTracingEnabled) {
      instrumentations.forEach(instrumentationKey => {
        const instrumentationName = /.\/instrumentation\/[^/]*\/(.*)/.exec(instrumentationKey)[1];
        const isDisabled =
          config.tracing.disabledTracers.findIndex(disabledKey => instrumentationName.toLowerCase() === disabledKey) !==
          -1;
        if (!isDisabled) {
          instrumentationModules[instrumentationKey].activate();
        }
      });
    }
  }
};

exports.deactivate = function deactivate() {
  if (tracingEnabled && tracingActivated) {
    tracingActivated = false;

    if (automaticTracingEnabled) {
      instrumentations.forEach(instrumentationKey => {
        instrumentationModules[instrumentationKey].deactivate();
      });
    }

    opentracing.deactivate();
    spanBuffer.deactivate();
    sdk.deactivate();
  }
};

exports.getHandleForCurrentSpan = function getHandleForCurrentSpan() {
  return spanHandle.getHandleForCurrentSpan(cls);
};

exports.getCls = function getCls() {
  // This only provides a value if tracing is enabled, otherwise cls will not be required and is null.
  return cls;
};

/**
 * @param {Array.<string>} _extraHeaders
 */
exports.setExtraHttpHeadersToCapture = function setExtraHttpHeadersToCapture(_extraHeaders) {
  extraHeaders = _extraHeaders;
  instrumentations.forEach(instrumentationKey => {
    if (
      instrumentationModules[instrumentationKey] &&
      typeof instrumentationModules[instrumentationKey].setExtraHttpHeadersToCapture === 'function'
    ) {
      instrumentationModules[instrumentationKey].setExtraHttpHeadersToCapture(extraHeaders);
    }
  });
};

// This will be removed again after the opt-in transition phase.
exports.enableSpanBatching = function enableSpanBatching() {
  spanBuffer.enableSpanBatching();
};

exports._getAndResetTracingMetrics = function _getAndResetTracingMetrics() {
  return {
    pid:
      // TODO: This is not typed yet -> /nodejs/packages/collector/src/pidStore/index.js
      // @ts-ignore
      processIdentityProvider && typeof processIdentityProvider.getEntityId === 'function'
        ? // @ts-ignore
          processIdentityProvider.getEntityId()
        : undefined,
    metrics: tracingMetrics.getAndReset()
  };
};

/**
 * @param {string} name
 * @param {*} module_
 */
exports._instrument = function _instrument(name, module_) {
  if (name === 'superagent') {
    require('./instrumentation/protocols/superagent').instrument(module_);
  } else {
    throw new Error(`An unknown or unsupported instrumentation has been requested: ${name}`);
  }
};

exports._debugCurrentSpanName = function _debugCurrentSpanName() {
  if (!cls) {
    return 'current: no cls';
  }
  const s = cls.ns.get('com.instana.span');
  if (!s) {
    return 'current: no span';
  }
  return `current: ${s.n}`;
};
