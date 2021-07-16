/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2019
 */

'use strict';

const instanaCore = require('@instana/core');
const { tracingHeaders } = require('@instana/core').tracing;
const { backendConnector, consoleLogger } = require('@instana/serverless');

const arnParser = require('./arn');
const identityProvider = require('./identity_provider');
const metrics = require('./metrics');
const triggers = require('./triggers');
const processResult = require('./process_result');
const captureHeaders = require('./capture_headers');

const { tracing } = instanaCore;
const { constants, spanBuffer } = tracing;
let logger = consoleLogger;
let config;

let coldStart = true;

// Initialize instrumentations early to allow for require statements after our package has been required but before the
// actual instana.wrap(...) call.
instanaCore.preInit();

/**
 * Wraps an AWS Lambda handler so that metrics and traces are reported to Instana. This function will figure out if the
 * Lambda handler uses the callback style or promise/async function style by inspecting the number of function arguments
 * the function receives.
 */
exports.wrap = function wrap(_config, originalHandler) {
  /* eslint-disable no-unused-vars */
  if (arguments.length === 1) {
    originalHandler = _config;
    _config = null;
  }

  // Apparently the AWS Lambda Node.js runtime does not inspect the handlers signature for the number of arguments it
  // accepts. But to be extra safe, we strive to return a function with the same number of arguments anyway.
  switch (originalHandler.length) {
    case 0:
      return function handler0() {
        return shimmedHandler(originalHandler, this, arguments, _config);
      };
    case 1:
      return function handler1(event) {
        return shimmedHandler(originalHandler, this, arguments, _config);
      };
    case 2:
      return function handler2(event, context) {
        return shimmedHandler(originalHandler, this, arguments, _config);
      };
    default:
      return function handler3(event, context, callback) {
        return shimmedHandler(originalHandler, this, arguments, _config);
      };
  }
};

function shimmedHandler(originalHandler, originalThis, originalArgs, _config) {
  const event = originalArgs[0];
  const context = originalArgs[1];
  const lambdaCallback = originalArgs[2];

  const arnInfo = arnParser(context);
  init(event, arnInfo, _config);

  // The AWS lambda runtime does not seem to inspect the number of arguments the handler function expects. Instead, it
  // always call the handler with three arguments (event, context, callback), no matter if the handler will use the
  // callback or not. If the handler returns a promise, the runtime uses the that promise's value when it resolves as
  // the result. If the handler calls the callback, that value is used as the result. If the handler does both
  // (return a promise and resolve it _and_ call the callback), it depends on the timing. Whichever happens first
  // dictates the result of the lambda invocation, the later result is ignored. To match this behaviour, we always
  // wrap the given callback _and_ return an instrumented promise.
  let handlerHasFinished = false;
  return tracing.getCls().ns.runPromiseOrRunAndReturn(() => {
    const traceCorrelationData = triggers.readTraceCorrelationData(event, context);
    const tracingSuppressed = traceCorrelationData.level === '0';
    const w3cTraceContext = traceCorrelationData.w3cTraceContext;

    let entrySpan;

    if (w3cTraceContext) {
      // Ususally we commit the W3C trace context to CLS in start span, but in some cases (e.g. when suppressed),
      // we don't call startSpan, so we write to CLS here unconditionally. If we also write an updated trace context
      // later, the one written here will be overwritten.
      tracing.getCls().setW3cTraceContext(w3cTraceContext);
    }

    if (tracingSuppressed) {
      tracing.getCls().setTracingLevel('0');
      if (w3cTraceContext) {
        w3cTraceContext.disableSampling();
      }
    } else {
      entrySpan = tracing
        .getCls()
        .startSpan(
          'aws.lambda.entry',
          constants.ENTRY,
          traceCorrelationData.traceId,
          traceCorrelationData.parentId,
          w3cTraceContext
        );
      tracingHeaders.setSpanAttributes(entrySpan, traceCorrelationData);
      const { arn, alias } = arnInfo;
      entrySpan.data.lambda = {
        arn,
        alias,
        runtime: 'nodejs',
        functionName: context.functionName,
        functionVersion: context.functionVersion,
        reqId: context.awsRequestId
      };
      if (coldStart) {
        entrySpan.data.lambda.coldStart = true;
        coldStart = false;
      }
      triggers.enrichSpanWithTriggerData(event, context, entrySpan);
    }

    originalArgs[2] = function wrapper(originalError, originalResult) {
      if (handlerHasFinished) {
        lambdaCallback(originalError, originalResult);
        return;
      }
      handlerHasFinished = true;
      postHandler(entrySpan, originalError, originalResult, () => {
        lambdaCallback(originalError, originalResult);
      });
    };

    // The functions context.done, context.succeed, and context.fail constitute a deprecated legacy Lambda API from the
    // very first incarnations of the Node.js Lambda execution environment from ca. 2016. Although it is not documented
    // anymore in the AWS Lambda docs, it still works (and is also used by some customers). See
    // eslint-disable-next-line max-len
    // https://web.archive.org/web/20161216092320/https://docs.aws.amazon.com/lambda/latest/dg/nodejs-prog-model-using-old-runtime.html
    // for information about it.
    const originalDone = context.done;
    context.done = (originalError, originalResult) => {
      if (handlerHasFinished) {
        originalDone(originalError, originalResult);
        return;
      }
      handlerHasFinished = true;
      postHandler(entrySpan, originalError, originalResult, () => {
        originalDone(originalError, originalResult);
      });
    };

    const originalSucceed = context.succeed;
    context.succeed = originalResult => {
      if (handlerHasFinished) {
        originalSucceed(originalResult);
        return;
      }
      handlerHasFinished = true;
      postHandler(entrySpan, undefined, originalResult, () => {
        originalSucceed(originalResult);
      });
    };

    const originalFail = context.fail;
    context.fail = originalError => {
      if (handlerHasFinished) {
        originalFail(originalError);
        return;
      }
      handlerHasFinished = true;
      postHandler(entrySpan, originalError, undefined, () => {
        originalFail(originalError);
      });
    };

    registerTimeoutDetection(context, entrySpan);

    let handlerPromise;
    try {
      handlerPromise = originalHandler.apply(originalThis, originalArgs);
      if (handlerPromise && typeof handlerPromise.then === 'function') {
        return handlerPromise.then(
          value => {
            if (handlerHasFinished) {
              return Promise.resolve(value);
            }
            handlerHasFinished = true;
            return postPromise(entrySpan, null, value);
          },
          error => {
            if (handlerHasFinished) {
              return Promise.reject(error);
            }
            handlerHasFinished = true;
            return postPromise(entrySpan, error);
          }
        );
      } else {
        return handlerPromise;
      }
    } catch (e) {
      // A synchronous exception occured in the original handler.
      handlerHasFinished = true;
      // eslint-disable-next-line no-console
      console.error(
        // eslint-disable-next-line max-len
        'Your Lambda handler threw a synchronous exception. To report this call (including the error) to Instana, we need to convert this synchronous failure into an asynchronous failure.',
        e
      );

      postHandler(entrySpan, e, undefined, () => {
        // rethrow original exception
        throw e;
      });
      return handlerPromise;
    }
  });
}

/**
 * Initialize the wrapper.
 */
function init(event, arnInfo, _config) {
  config = _config || {};

  if (config.logger) {
    logger = config.logger;
  } else if (process.env.INSTANA_DEBUG || config.level || process.env.INSTANA_LOG_LEVEL) {
    logger.setLevel(process.env.INSTANA_DEBUG ? 'debug' : config.level || process.env.INSTANA_LOG_LEVEL);
  }

  identityProvider.init(arnInfo);
  const useLambdaExtension = shouldUseLambdaExtension();
  if (useLambdaExtension) {
    logger.info('@instana/aws-lambda will use the Instana Lambda extension to send data to the Instana back end.');
  } else {
    logger.info(
      '@instana/aws-lambda will not use the Instana Lambda extension, but instead send data to the Instana back end ' +
        'directly.'
    );
  }

  backendConnector.init(identityProvider, logger, true, false, 500, useLambdaExtension);

  // instanaCore.init also normalizes the config as a side effect
  instanaCore.init(config, backendConnector, identityProvider);

  captureHeaders.init(config);
  metrics.init(config);
  metrics.activate();
  tracing.activate();
}

function registerTimeoutDetection(context, entrySpan) {
  // We register the timeout detection directly at the start so getRemainingTimeInMillis basically gives us the
  // configured timeout for this Lambda function, minus roughly 50 - 100 ms that is spent in bootstrapping.
  const initialRemainingMillis = getRemainingTimeInMillis(context);
  if (typeof initialRemainingMillis !== 'number') {
    return;
  }
  if (initialRemainingMillis <= 2500) {
    logger.debug(
      'Heuristical timeout detection will be disabled for Lambda functions with a short timeout ' +
        '(2 seconds and smaller).'
    );
    return;
  }

  let triggerTimeoutHandlingAfter;
  if (initialRemainingMillis <= 4000) {
    // For Lambdas configured with a timeout of 3 or 4 seconds we heuristically assume a timeout when only
    // 10% of time is remaining.
    triggerTimeoutHandlingAfter = initialRemainingMillis * 0.9;
  } else {
    // For Lambdas configured with a timeout of  5 seconds or more we heuristically assume a timeout when only 400 ms of
    // time are remaining.
    triggerTimeoutHandlingAfter = initialRemainingMillis - 400;
  }

  logger.debug(
    `Registering heuristical timeout detection to be triggered in ${triggerTimeoutHandlingAfter} milliseconds.`
  );

  setTimeout(() => {
    postHandlerForTimeout(entrySpan, getRemainingTimeInMillis(context));
  }, triggerTimeoutHandlingAfter).unref();
}

function getRemainingTimeInMillis(context) {
  if (context && typeof context.getRemainingTimeInMillis === 'function') {
    return context.getRemainingTimeInMillis();
  } else {
    logger.warn('context.getRemainingTimeInMillis() is not available, timeout detection will be disabled.');
    return null;
  }
}

function shouldUseLambdaExtension() {
  if (process.env.INSTANA_DISABLE_LAMBDA_EXTENSION) {
    logger.info('INSTANA_DISABLE_LAMBDA_EXTENSION is set, not using the Lambda extension.');
    return false;
  } else {
    // Note: We could also use context.memoryLimitInMB here instead of the env var AWS_LAMBDA_FUNCTION_MEMORY_SIZE (both
    // should always yield the same value), but this behaviour needs to be in sync with what the Lambda extension does.
    // The context object is not available to the extension, so we prefer the env var over the value from the context.
    const memorySetting = process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE;
    if (!memorySetting) {
      logger.debug(
        'The environment variable AWS_LAMBDA_FUNCTION_MEMORY_SIZE is not present, cannot determine memory settings.'
      );
      return true;
    }
    const memorySize = parseInt(memorySetting, 10);
    if (isNaN(memorySize)) {
      logger.debug(
        `Could not parse the value of the environment variable AWS_LAMBDA_FUNCTION_MEMORY_SIZE: "${memorySetting}", ` +
          'cannot determine memory settings, not using the Lambda extension.'
      );
      return false;
    }
    if (memorySize < 256) {
      logger.debug(
        'The Lambda function is configured with less than 256 MB of memory according to the value of ' +
          `AWS_LAMBDA_FUNCTION_MEMORY_SIZE: ${memorySetting}. Offloading data via a Lambda extension does currently ` +
          'not work reliably with low memory settings, therefore not using the Lambda extension.'
      );
      return false;
    }
    return true;
  }
}

/**
 * A wrapper for post handler for promise based Lambdas (including async style Lambdas), to be executed after the
 * promise returned by the original handler has completed.
 */
function postPromise(entrySpan, error, value) {
  return new Promise((resolve, reject) => {
    postHandler(entrySpan, error, value, () => {
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    });
  });
}

/**
 * When the original handler has completed, the postHandler will finish the entry span that represents the Lambda
 * invocation and makes sure the final batch of data (including the Lambda entry span) is sent to the back end before
 * letting the Lambda finish (that is, before letting the AWS Lambda runtime process the next invocation or freeze the
 * current process).
 */
function postHandler(entrySpan, error, result, callback) {
  // entrySpan is null when tracing is suppressed due to X-Instana-L
  if (entrySpan) {
    if (entrySpan.transmitted) {
      // The only possible reason for the entry span to already have been transmitted is when the timeout detection
      // kicked in and finished the entry span prematurely. If that happened, we also have already triggered sending
      // spans to the back end. We do not need to keep the Lambda waiting for another transmission, so we immediately
      // let it finish.
      callback();
      return;
    }

    if (error) {
      entrySpan.ec = 1;
      if (error.message) {
        if (typeof error.message === 'string') {
          entrySpan.data.lambda.error = error.message;
        } else {
          entrySpan.data.lambda.error = JSON.stringify(error.message);
        }
      } else {
        entrySpan.data.lambda.error = error.toString();
      }
    }

    processResult(result, entrySpan);

    entrySpan.d = Date.now() - entrySpan.ts;

    entrySpan.transmit();
  }

  const spans = spanBuffer.getAndResetSpans();

  const metricsData = metrics.gatherData();

  const metricsPayload = {
    plugins: [{ name: 'com.instana.plugin.aws.lambda', entityId: identityProvider.getEntityId(), data: metricsData }]
  };

  backendConnector.sendBundle({ spans, metrics: metricsPayload }, true, callback);
}

/**
 * When the timeout heuristic detects an imminent timeout, we finish the entry span prematurely and send it to the
 * back end.
 */
function postHandlerForTimeout(entrySpan, remainingMillis) {
  logger.debug(`Heuristical timeout detection was triggered with ${remainingMillis} milliseconds left.`);

  if (entrySpan) {
    entrySpan.ec = 1;
    entrySpan.data.lambda.msleft = remainingMillis;
    entrySpan.data.lambda.error =
      `The Lambda function was still running when only ${remainingMillis} ms were left, ` +
      'it might have ended in a timeout.';
    entrySpan.d = Date.now() - entrySpan.ts;
    entrySpan.transmit();
  }

  // deliberately not gathering metrics but only sending spans.
  const spans = spanBuffer.getAndResetSpans();
  backendConnector.sendBundle({ spans }, true, () => {});
}

exports.currentSpan = function getHandleForCurrentSpan() {
  return tracing.getHandleForCurrentSpan();
};

exports.sdk = tracing.sdk;

exports.setLogger = function setLogger(_logger) {
  logger = _logger;
  config.logger = logger;
  instanaCore.logger.init(config);
  backendConnector.setLogger(logger);
};

exports.opentracing = tracing.opentracing;
