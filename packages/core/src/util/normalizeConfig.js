/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2019
 */

/* eslint-disable */

'use strict';

const supportedTracingVersion = require('../tracing/supportedVersion');

/**
 * @typedef {Object} HTTPTracingOption
 * @property {Array<*>} [extraHttpHeadersToCapture]
 */

/**
 * @typedef {Object} InstanaTracingOption
 * @property {boolean} [enabled]
 * @property {boolean} [automaticTracingEnabled]
 * @property {boolean} [activateImmediately]
 * @property {number} [forceTransmissionStartingAt]
 * @property {number} [maxBufferedSpans]
 * @property {number} [transmissionDelay]
 * @property {number} [maxKeepAliveUntilSpanBufferIsEmpty]
 * @property {number} [stackTraceLength]
 * @property {HTTPTracingOption} [http]
 * @property {Array<*>} [disabledTracers]
 * @property {boolean} [spanBatchingEnabled]
 * @property {boolean} [disableAutomaticTracing]
 * @property {boolean} [disableW3cTraceCorrelation]
 * @property {boolean} [ephemeralProcess]
 */

/**
 * @typedef {Object} InstanaMetricsOption
 * @property {number} [transmissionDelay]
 * @property {number} [timeBetweenHealthcheckCalls]
 */

/**
 * @typedef {Object} InstanaSecretsOption
 * @property {string} [matcherMode]
 * @property {Array<string>} [keywords]
 */

/**
 * @typedef {Object} InstanaConfig
 * @property {string} [serviceName]
 * @property {InstanaMetricsOption} [metrics]
 * @property {InstanaTracingOption} [tracing]
 * @property {InstanaSecretsOption} [secrets]
 * @property {number} [timeBetweenHealthcheckCalls]
 * @property {boolean} [ephemeralProcess]
 */

/** @type {import('../logger').GenericLogger} */
let logger;
logger = require('../logger').getLogger('configuration', newLogger => {
  logger = newLogger;
});

/** @type {InstanaConfig} */
const defaults = {
  serviceName: null,

  metrics: {
    transmissionDelay: 1000,
    timeBetweenHealthcheckCalls: 3000
  },
  tracing: {
    enabled: true,
    automaticTracingEnabled: true,
    activateImmediately: false,
    forceTransmissionStartingAt: 500,
    maxBufferedSpans: 1000,
    transmissionDelay: 1000,
    maxKeepAliveUntilSpanBufferIsEmpty: 0,
    http: {
      extraHttpHeadersToCapture: []
    },
    stackTraceLength: 10,
    disabledTracers: [],
    spanBatchingEnabled: false,
    disableW3cTraceCorrelation: false,
    ephemeralProcess: false
  },
  secrets: {
    matcherMode: 'contains-ignore-case',
    keywords: ['key', 'pass', 'secret']
  }
};

const validSecretsMatcherModes = ['equals-ignore-case', 'equals', 'contains-ignore-case', 'contains', 'regex', 'none'];

/**
 * Merges the config that was passed to the init function with environment variables and default values.
 */

/**
 * @type {Function}
 * @param {InstanaConfig} config
 * @returns {InstanaConfig}
 */
module.exports = exports = function normalizeConfig(config) {
  if (config == null) {
    config = {};
  }

  normalizeServiceName(config);
  normalizeMetricsConfig(config);
  normalizeTracingConfig(config);
  normalizeSecrets(config);
  return config;
};

/**
 * @param {InstanaConfig} config
 */
function normalizeServiceName(config) {
  if (config.serviceName == null && process.env['INSTANA_SERVICE_NAME']) {
    config.serviceName = process.env['INSTANA_SERVICE_NAME'];
  }
  if (config.serviceName != null && typeof config.serviceName !== 'string') {
    logger.warn(
      `Invalid configuration: config.serviceName is not a string, the value will be ignored: ${config.serviceName}`
    );
    config.serviceName = defaults.serviceName;
  }
}

/**
 * @param {InstanaConfig} config
 */
function normalizeMetricsConfig(config) {
  if (config.metrics == null) {
    config.metrics = {};
  }

  config.metrics.transmissionDelay = normalizeSingleValue(
    config.metrics.transmissionDelay,
    defaults.metrics.transmissionDelay,
    'config.metrics.transmissionDelay',
    'INSTANA_METRICS_TRANSMISSION_DELAY'
  );

  // The correct location for this is config.metrics.timeBetweenHealthcheckCalls but previous versions accepted
  // config.timeBetweenHealthcheckCalls. We still accept that to not break applications relying on that.
  config.metrics.timeBetweenHealthcheckCalls =
    config.metrics.timeBetweenHealthcheckCalls ||
    config.timeBetweenHealthcheckCalls ||
    defaults.metrics.timeBetweenHealthcheckCalls;
  delete config.timeBetweenHealthcheckCalls;
}

/**
 *
 * @param {InstanaConfig} config
 */
function normalizeTracingConfig(config) {
  if (config.tracing == null) {
    config.tracing = {};
  }
  normalizeTracingEnabled(config);
  normalizeAutomaticTracingEnabled(config);
  normalizeEphemeralProcess(config);
  normalizeActivateImmediately(config);
  normalizeTracingTransmission(config);
  normalizeTracingHttp(config);
  normalizeTracingStackTraceLength(config);
  normalizeDisabledTracers(config);
  normalizeSpanBatchingEnabled(config);
  normalizeDisableW3cTraceCorrelation(config);
}

/**
 *
 * @param {InstanaConfig} config
 */
function normalizeTracingEnabled(config) {
  if (config.tracing.enabled === false) {
    logger.info('Not enabling tracing as it is explicitly disabled via config.');
    return;
  }
  if (config.tracing.enabled === true) {
    return;
  }
  if (process.env['INSTANA_DISABLE_TRACING'] === 'true') {
    logger.info('Not enabling tracing as it is explicitly disabled via environment variable INSTANA_DISABLE_TRACING.');
    config.tracing.enabled = false;
    delete config.tracing.disableAutomaticTracing;
    return;
  }

  config.tracing.enabled = defaults.tracing.enabled;
}

/**
 * @param {InstanaConfig} config
 */
function normalizeAutomaticTracingEnabled(config) {
  if (!config.tracing.enabled) {
    logger.info('Not enabling automatic tracing as tracing in general is explicitly disabled via config.');
    config.tracing.automaticTracingEnabled = false;
    return;
  }

  if (config.tracing.automaticTracingEnabled === false || config.tracing.disableAutomaticTracing) {
    logger.info('Not enabling automatic tracing as it is explicitly disabled via config.');
    config.tracing.automaticTracingEnabled = false;
    delete config.tracing.disableAutomaticTracing;
    return;
  }

  if (process.env['INSTANA_DISABLE_AUTO_INSTR'] === 'true') {
    logger.info(
      'Not enabling automatic tracing as it is explicitly disabled via environment variable INSTANA_DISABLE_AUTO_INSTR.'
    );
    config.tracing.automaticTracingEnabled = false;
    delete config.tracing.disableAutomaticTracing;
    return;
  }

  if (!supportedTracingVersion(process.versions.node)) {
    logger.warn(
      'Not enabling automatic tracing, this is an unsupported version of Node.js. ' +
        'See: https://www.instana.com/docs/ecosystem/node-js/#supported-nodejs-versions'
    );
    config.tracing.automaticTracingEnabled = false;
    return;
  }

  config.tracing.automaticTracingEnabled = defaults.tracing.automaticTracingEnabled;
}

/**
 * @param {InstanaConfig} config
 */
function normalizeEphemeralProcess(config) {
  if (!config.tracing.enabled) {
    config.tracing.ephemeralProcess = false;
    return;
  }

  if (config.tracing.ephemeralProcess != null) {
    if (typeof config.tracing.ephemeralProcess === 'boolean') {
      if (config.tracing.ephemeralProcess) {
        logger.info('Optimized trace settings for an ephemeral process are enabled via config.');
      }
      disableNativeAddonRetries();
      return;
    } else {
      logger.warn(
        `Invalid configuration: config.tracing.ephemeralProcess is not a boolean value, will be ignored: ${JSON.stringify(
          config.tracing.ephemeralProcess
        )}`
      );
    }
  }

  if (process.env['INSTANA_EPHEMERAL_PROCESS'] === 'true') {
    logger.info(
      'Optimized trace settings for an ephemeral process are enabled via environment variable INSTANA_EPHEMERAL_PROCESS.'
    );
    config.tracing.ephemeralProcess = true;
    disableNativeAddonRetries();
    return;
  }

  config.tracing.ephemeralProcess = defaults.tracing.ephemeralProcess;
}

function disableNativeAddonRetries() {
  process.env.INSTANA_COPY_PRECOMPILED_NATIVE_ADDONS = 'false';
  process.env.INSTANA_REBUILD_NATIVE_ADDONS_ON_DEMAND = 'false';
}

/**
 * @param {InstanaConfig} config
 */
function normalizeActivateImmediately(config) {
  if (!config.tracing.enabled) {
    config.tracing.activateImmediately = false;
    return;
  }

  if (typeof config.tracing.activateImmediately === 'boolean') {
    return;
  }

  if (process.env['INSTANA_TRACE_IMMEDIATELY'] === 'true') {
    config.tracing.activateImmediately = true;
    return;
  }

  if (process.env['INSTANA_TRACE_IMMEDIATELY'] === 'false') {
    config.tracing.activateImmediately = false;
    return;
  }

  if (config.tracing.ephemeralProcess) {
    config.tracing.activateImmediately = true;
    return;
  }

  config.tracing.activateImmediately = defaults.tracing.activateImmediately;
}

/**
 * @param {InstanaConfig} config
 */
function normalizeTracingTransmission(config) {
  config.tracing.maxBufferedSpans = config.tracing.maxBufferedSpans || defaults.tracing.maxBufferedSpans;

  config.tracing.transmissionDelay = normalizeSingleValue(
    config.tracing.transmissionDelay,
    defaults.tracing.transmissionDelay,
    'config.tracing.transmissionDelay',
    'INSTANA_TRACING_TRANSMISSION_DELAY'
  );

  if (
    config.tracing.forceTransmissionStartingAt == null &&
    process.env.INSTANA_FORCE_TRANSMISSION_STARTING_AT == null &&
    config.tracing.ephemeralProcess
  ) {
    config.tracing.forceTransmissionStartingAt = 1;
  } else {
    config.tracing.forceTransmissionStartingAt = normalizeSingleValue(
      config.tracing.forceTransmissionStartingAt,
      defaults.tracing.forceTransmissionStartingAt,
      'config.tracing.forceTransmissionStartingAt',
      'INSTANA_FORCE_TRANSMISSION_STARTING_AT'
    );
  }

  if (
    config.tracing.maxKeepAliveUntilSpanBufferIsEmpty == null &&
    process.env.INSTANA_MAX_KEEP_ALIVE_UNTIL_SPAN_BUFFER_IS_EMPTY == null &&
    config.tracing.ephemeralProcess
  ) {
    config.tracing.maxKeepAliveUntilSpanBufferIsEmpty = 5000;
  } else {
    config.tracing.maxKeepAliveUntilSpanBufferIsEmpty = normalizeSingleValue(
      config.tracing.maxKeepAliveUntilSpanBufferIsEmpty,
      defaults.tracing.maxKeepAliveUntilSpanBufferIsEmpty,
      'config.tracing.maxKeepAliveUntilSpanBufferIsEmpty',
      'INSTANA_MAX_KEEP_ALIVE_UNTIL_SPAN_BUFFER_IS_EMPTY'
    );
  }
}

/**
 * @param {InstanaConfig} config
 */
function normalizeTracingHttp(config) {
  config.tracing.http = config.tracing.http || {};

  let fromEnvVar;
  if (process.env.INSTANA_EXTRA_HTTP_HEADERS) {
    fromEnvVar = parseHeadersEnvVar(process.env.INSTANA_EXTRA_HTTP_HEADERS);
  }

  if (!config.tracing.http.extraHttpHeadersToCapture && !fromEnvVar) {
    config.tracing.http.extraHttpHeadersToCapture = defaults.tracing.http.extraHttpHeadersToCapture;
    return;
  } else if (!config.tracing.http.extraHttpHeadersToCapture && fromEnvVar) {
    config.tracing.http.extraHttpHeadersToCapture = fromEnvVar;
  }
  if (!Array.isArray(config.tracing.http.extraHttpHeadersToCapture)) {
    logger.warn(
      `Invalid configuration: config.tracing.http.extraHttpHeadersToCapture is not an array, the value will be ignored: ${JSON.stringify(
        config.tracing.http.extraHttpHeadersToCapture
      )}`
    );
    config.tracing.http.extraHttpHeadersToCapture = defaults.tracing.http.extraHttpHeadersToCapture;
    return;
  }

  config.tracing.http.extraHttpHeadersToCapture = config.tracing.http.extraHttpHeadersToCapture.map((
    s // Node.js HTTP API turns all incoming HTTP headers into lowercase.
  ) => s.toLowerCase());
}

/**
 * @param {string} envVarValue
 * @returns {Array<string>}
 */
function parseHeadersEnvVar(envVarValue) {
  return envVarValue
    .split(/[;,]/)
    .map(header => header.trim())
    .filter(header => header !== '');
}

/**
 * @param {InstanaConfig} config
 */
function normalizeTracingStackTraceLength(config) {
  if (config.tracing.stackTraceLength == null && process.env['INSTANA_STACK_TRACE_LENGTH']) {
    parseStringStackTraceLength(config, process.env['INSTANA_STACK_TRACE_LENGTH']);
  }
  if (config.tracing.stackTraceLength != null) {
    if (typeof config.tracing.stackTraceLength === 'number') {
      config.tracing.stackTraceLength = normalizeNumericalStackTraceLength(config.tracing.stackTraceLength);
    } else if (typeof config.tracing.stackTraceLength === 'string') {
      parseStringStackTraceLength(config, config.tracing.stackTraceLength);
    } else {
      logger.warn(
        'The value of config.tracing.stackTraceLength has the non-supported type %s (the value is "%s"). Assuming ' +
          'the default stack trace length %s.',
        typeof config.tracing.stackTraceLength,
        config.tracing.stackTraceLength,
        defaults.tracing.stackTraceLength
      );
      config.tracing.stackTraceLength = defaults.tracing.stackTraceLength;
    }
  } else {
    config.tracing.stackTraceLength = defaults.tracing.stackTraceLength;
  }
}

/**
 * @param {InstanaConfig} config
 * @param {string} value
 */
function parseStringStackTraceLength(config, value) {
  config.tracing.stackTraceLength = parseInt(value, 10);
  if (!isNaN(config.tracing.stackTraceLength)) {
    config.tracing.stackTraceLength = normalizeNumericalStackTraceLength(config.tracing.stackTraceLength);
  } else {
    logger.warn(
      'The value of config.tracing.stackTraceLength ("%s") has type string and cannot be parsed to a numerical ' +
        'value. Assuming the default stack trace length %s.',
      value,
      defaults.tracing.stackTraceLength
    );
    config.tracing.stackTraceLength = defaults.tracing.stackTraceLength;
  }
}

/**
 * @param {number} numericalLength
 * @returns {number}
 */
function normalizeNumericalStackTraceLength(numericalLength) {
  // just in case folks provide non-integral numbers or negative numbers
  const normalized = Math.abs(Math.round(numericalLength));
  if (normalized !== numericalLength) {
    logger.warn(
      'Normalized the provided value of config.tracing.stackTraceLength (%s) to %s.',
      numericalLength,
      normalized
    );
  }
  return normalized;
}

/**
 * @param {InstanaConfig} config
 */
function normalizeDisabledTracers(config) {
  if (
    config.tracing.disabledTracers == null &&
    process.env['INSTANA_DISABLED_TRACERS'] &&
    process.env['INSTANA_DISABLED_TRACERS'].trim().length >= 0
  ) {
    config.tracing.disabledTracers = process.env['INSTANA_DISABLED_TRACERS']
      .split(',')
      .map(key => key.trim().toLowerCase())
      .filter(key => key.length >= 0);
  }

  if (!config.tracing.disabledTracers) {
    config.tracing.disabledTracers = defaults.tracing.disabledTracers;
  }

  if (!Array.isArray(config.tracing.disabledTracers)) {
    logger.warn(
      `Invalid configuration: config.tracing.disabledTracers is not an array, the value will be ignored: ${JSON.stringify(
        config.tracing.disabledTracers
      )}`
    );
    config.tracing.disabledTracers = defaults.tracing.disabledTracers;
    return;
  }

  config.tracing.disabledTracers = config.tracing.disabledTracers.map((
    s // We'll check for matches in an case-insensitive fashion
  ) => s.toLowerCase());
}

/**
 * @param {InstanaConfig} config
 */
function normalizeSpanBatchingEnabled(config) {
  if (config.tracing.spanBatchingEnabled != null) {
    if (typeof config.tracing.spanBatchingEnabled === 'boolean') {
      if (config.tracing.spanBatchingEnabled) {
        logger.info('Span batching is enabled via config.');
      }
      return;
    } else {
      logger.warn(
        `Invalid configuration: config.tracing.spanBatchingEnabled is not a boolean value, will be ignored: ${JSON.stringify(
          config.tracing.spanBatchingEnabled
        )}`
      );
    }
  }

  if (process.env['INSTANA_SPANBATCHING_ENABLED'] === 'true') {
    logger.info('Span batching is enabled via environment variable INSTANA_SPANBATCHING_ENABLED.');
    config.tracing.spanBatchingEnabled = true;
    return;
  }

  config.tracing.spanBatchingEnabled = defaults.tracing.spanBatchingEnabled;
}

/**
 * @param {InstanaConfig} config
 */
function normalizeDisableW3cTraceCorrelation(config) {
  if (config.tracing.disableW3cTraceCorrelation === true) {
    logger.info('W3C trace correlation has been disabled via config.');
    return;
  }
  if (process.env['INSTANA_DISABLE_W3C_TRACE_CORRELATION']) {
    logger.info(
      'W3C trace correlation has been disabled via environment variable INSTANA_DISABLE_W3C_TRACE_CORRELATION.'
    );
    config.tracing.disableW3cTraceCorrelation = true;
    return;
  }

  config.tracing.disableW3cTraceCorrelation = defaults.tracing.disableW3cTraceCorrelation;
}

/**
 * @param {InstanaConfig} config
 */
function normalizeSecrets(config) {
  if (config.secrets == null) {
    config.secrets = {};
  }

  /** @type {InstanaSecretsOption} */
  let fromEnvVar = {};
  if (process.env.INSTANA_SECRETS) {
    fromEnvVar = parseSecretsEnvVar(process.env.INSTANA_SECRETS);
  }

  config.secrets.matcherMode = config.secrets.matcherMode || fromEnvVar.matcherMode || defaults.secrets.matcherMode;
  config.secrets.keywords = config.secrets.keywords || fromEnvVar.keywords || defaults.secrets.keywords;

  if (typeof config.secrets.matcherMode !== 'string') {
    logger.warn(
      'The value of config.secrets.matcherMode ("%s") is not a string. Assuming the default value %s.',
      config.secrets.matcherMode,
      defaults.secrets.matcherMode
    );
    config.secrets.matcherMode = defaults.secrets.matcherMode;
  } else if (validSecretsMatcherModes.indexOf(config.secrets.matcherMode) < 0) {
    logger.warn(
      'The value of config.secrets.matcherMode (or the matcher mode parsed from INSTANA_SECRETS) (%s) is not a supported matcher mode. Assuming the default value %s.',
      config.secrets.matcherMode,
      defaults.secrets.matcherMode
    );
    config.secrets.matcherMode = defaults.secrets.matcherMode;
  } else if (!Array.isArray(config.secrets.keywords)) {
    logger.warn(
      'The value of config.secrets.keywords (%s) is not an array. Assuming the default value %s.',
      config.secrets.keywords,
      defaults.secrets.keywords
    );
    config.secrets.keywords = defaults.secrets.keywords;
  }
  if (config.secrets.matcherMode === 'none') {
    config.secrets.keywords = [];
  }
}

/**
 * @param {string} envVarValue
 * @returns {InstanaSecretsOption}
 */
function parseSecretsEnvVar(envVarValue) {
  let [matcherMode, keywords] = envVarValue.split(':', 2);
  matcherMode = matcherMode.trim().toLowerCase();

  if (matcherMode === 'none') {
    return {
      matcherMode,
      keywords: []
    };
  }

  if (!keywords) {
    // a list of keywords (with at least one element) is mandatory for all matcher modes except "none"
    logger.warn(
      'The value of INSTANA_SECRETS (%s) cannot be parsed. Please use the following format: INSTANA_SECRETS=<matcher>:<secret>[,<secret>]. This setting will be ignored.',
      envVarValue
    );
    return {};
  }
  const keywordsArray = keywords.split(',').map(word => word.trim());
  return {
    matcherMode,
    keywords: keywordsArray
  };
}

/**
 * @param {*} configValue
 * @param {*} defaultValue
 * @param {string} configPath
 * @param {string} envVarKey
 * @returns {*}
 */
function normalizeSingleValue(configValue, defaultValue, configPath, envVarKey) {
  const envVarVal = process.env[envVarKey];
  let originalValue = configValue;
  if (configValue == null && envVarVal == null) {
    return defaultValue;
  } else if (configValue == null && envVarVal != null) {
    originalValue = envVarVal;
    configValue = parseInt(originalValue, 10);
  }

  if (typeof configValue !== 'number' || isNaN(configValue)) {
    logger.warn(
      'The value of %s (or %s) ("%s") is ' +
        'not numerical or cannot be parsed to a numerical value. Assuming the default value %s.',
      configPath,
      envVarKey,
      originalValue,
      defaultValue
    );
    return defaultValue;
  }
  return configValue;
}
