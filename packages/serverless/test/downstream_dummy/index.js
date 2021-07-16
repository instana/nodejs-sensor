/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2019
 */

'use strict';

const express = require('express');
const http = require('http');
const morgan = require('morgan');
const pino = require('pino')();

const { sendToParent } = require('../../../core/test/test_util');
const delay = require('../../../core/test/test_util/delay');

const logPrefix = 'downstream-dummy';
const logger = pino.child({ name: logPrefix, pid: process.pid });
logger.level = 'info';

const port = process.env.DOWNSTREAM_DUMMY_PORT || 3456;
const app = express();

if (process.env.WITH_STDOUT) {
  app.use(morgan(`${logPrefix} (${process.pid}): :method :url :status`));
}

app.get('/', (req, res) => {
  const rawHeaders = req.rawHeaders.slice();
  ['Accept', 'Accept-Encoding', 'Connection', 'Host', 'User-Agent'].forEach(headerName => {
    const idx = rawHeaders.indexOf(headerName);
    rawHeaders.splice(idx, 2);
  });
  const headersToEcho = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    headersToEcho[rawHeaders[i]] = rawHeaders[i + 1];
  }
  delay(200).then(() => {
    res.json(headersToEcho);
  });
});

http.createServer(app).listen(port, error => {
  if (error) {
    logger.error(error);
    process.exit(1);
    return; // eslint-disable-line no-useless-return
  } else {
    logger.info('Listening on port: %s', port);
    sendToParent('downstream dummy: started');
  }
});
