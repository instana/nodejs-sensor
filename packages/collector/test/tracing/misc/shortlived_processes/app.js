/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2021
 */

'use strict';

const instana = require('../../../../')({
  level: 'error',
  tracing: {
    ephemeralProcess: true
  }
});

const bodyParser = require('body-parser');
const express = require('express');
const morgan = require('morgan');
const got = require('got');

const { delay } = require('../../../../../core/test/test_util');

const logPrefix = `Short Lived Process (${process.pid}):\t`;

const agentPort = process.env.INSTANA_AGENT_PORT;

const app = express();

if (process.env.WITH_STDOUT) {
  app.use(morgan(`${logPrefix}:method :url :status`));
}

app.use(bodyParser.json());

app.get('/', (req, res) => res.sendStatus(200));

app.listen(process.env.APP_PORT, () => {
  log(`Listening on port: ${process.env.APP_PORT}`);
});

if (process.env.MANUAL_TRACING) {
  // manual tracing via SDK
  createSpans();
} else {
  // add a route that will be used for the autotrace test
  app.post('/do-stuff', (req, res) => {
    got(`http://127.0.0.1:${agentPort}`).then(() => {
      res.sendStatus(201);
    });
  });
}

async function createSpans() {
  await instana.sdk.promise.startEntrySpan('test-entry');
  await instana.sdk.promise.startExitSpan('test-exit');
  await delay(25);
  instana.sdk.promise.completeExitSpan();
  instana.sdk.promise.completeEntrySpan();
}

function log() {
  const args = Array.prototype.slice.call(arguments);
  args[0] = logPrefix + args[0];
  // eslint-disable-next-line no-console
  console.log.apply(console, args);
}
