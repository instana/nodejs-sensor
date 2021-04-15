/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2015
 */

'use strict';

const secrets = require('@instana/core').secrets;
const tracing = require('@instana/core').tracing;

let logger;
logger = require('../logger').getLogger('announceCycle/unannounced', newLogger => {
  logger = newLogger;
});
const agentConnection = require('../agentConnection');
const agentOpts = require('../agent/opts');
const pidStore = require('../pidStore');

const initialRetryDelay = 1000; // one second
const backoffFactor = 1.5;
const maxRetryDelay = 60 * 1000; // one minute

module.exports = {
  enter: function(ctx) {
    tryToAnnounce(ctx);
  },

  leave: function() {}
};

function tryToAnnounce(ctx, retryDelay = initialRetryDelay) {
  let nextRetryDelay;
  if (retryDelay * backoffFactor >= maxRetryDelay) {
    nextRetryDelay = maxRetryDelay;
  } else {
    nextRetryDelay = retryDelay * backoffFactor;
  }
  agentConnection.announceNodeCollector((err, rawResponse) => {
    if (err) {
      logger.info('Announce attempt failed: %s. Will retry in %s ms', err.message, retryDelay);
      setTimeout(tryToAnnounce, retryDelay, ctx, nextRetryDelay).unref();
      return;
    }

    let response;
    try {
      response = JSON.parse(rawResponse);
    } catch (e) {
      logger.warn(
        'Failed to JSON.parse agent response. Response was %s. Will retry in %s ms',
        rawResponse,
        retryDelay,
        e
      );
      setTimeout(tryToAnnounce, retryDelay, ctx, nextRetryDelay).unref();
      return;
    }

    const pid = response.pid;
    logger.info('Overwriting pid for reporting purposes to: %s', pid);
    pidStore.pid = pid;

    agentOpts.agentUuid = response.agentUuid;
    if (Array.isArray(response.extraHeaders)) {
      tracing.setExtraHttpHeadersToCapture(
        // Node.js HTTP API turns all incoming HTTP headers into lowercase.
        response.extraHeaders.map(s => s.toLowerCase())
      );
    }
    if (response.spanBatchingEnabled === true || response.spanBatchingEnabled === 'true') {
      logger.info('Enabling span batching via agent configuration.');
      tracing.enableSpanBatching();
    }

    if (response.secrets) {
      if (!(typeof response.secrets.matcher === 'string')) {
        logger.warn(
          'Received invalid secrets configuration from agent, attribute matcher is not a string: $s',
          response.secrets.matcher
        );
      } else if (Object.keys(secrets.matchers).indexOf(response.secrets.matcher) < 0) {
        logger.warn(
          'Received invalid secrets configuration from agent, matcher is not supported: $s',
          response.secrets.matcher
        );
      } else if (!Array.isArray(response.secrets.list)) {
        logger.warn(
          'Received invalid secrets configuration from agent, attribute list is not an array: $s',
          response.secrets.list
        );
      } else {
        secrets.setMatcher(response.secrets.matcher, response.secrets.list);
      }
    }

    ctx.transitionTo('announced');
  });
}
