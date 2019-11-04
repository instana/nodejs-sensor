/* eslint-disable indent, import/order, no-console */

'use strict';

const instana = require('../..');

// In production, the package @instana/aws-lambda is located in
// /var/task/node_modules/@instana/aws-lambda/src/metrics while the main package.json of the Lambda is in
// /var/task/package.json. The assumption about the relative location does not hold in the tests, so we need to fix the
// assumed root dir of the Lambda.
require('../../src/metrics/rootDir').root = require('path').resolve(__dirname, '..', '..');

const fetch = require('node-fetch');

const config = require('../../../serverless/test/config');

const responseHeaders = {
  'x-custom-header': 'custom header value'
};
if (process.env.SERVER_TIMING_HEADER) {
  if (process.env.SERVER_TIMING_HEADER === 'string') {
    responseHeaders['sErveR-tIming'] = 'cache;desc="Cache Read";dur=23.2';
  } else if (process.env.SERVER_TIMING_HEADER === 'array') {
    responseHeaders['ServEr-TiminG'] = ['cache;desc="Cache Read";dur=23.2', 'cpu;dur=2.4'];
  } else {
    throw new Error(`Unknown SERVER_TIMING_HEADER value: ${process.env.SERVER_TIMING_HEADER}.`);
  }
}

const handler = async event => {
  console.log('in actual handler');
  await fetch(config.downstreamDummyUrl);
  if (event.error) {
    throw new Error('Boom!');
  } else {
    return {
      statusCode: event.requestedStatusCode ? parseInt(event.requestedStatusCode, 10) : undefined,
      headers: responseHeaders,
      body: {
        message: 'Stan says hi!'
      }
    };
  }
};

const args = process.env.WITH_CONFIG
  ? [
      {
        tracing: {
          stackTraceLength: 2
        }
      },
      handler
    ]
  : [handler];

exports.handler = instana.awsLambda.wrap.apply(instana.awsLambda, args);
