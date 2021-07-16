/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2020
 */

'use strict';

const { expect } = require('chai');
const path = require('path');
const constants = require('@instana/core').tracing.constants;

const Control = require('../Control');
const { delay, expectExactlyNMatching } = require('../../../core/test/test_util');
const config = require('../../../serverless/test/config');

const functionName = 'functionName';
const unqualifiedArn = `arn:aws:lambda:us-east-2:410797082306:function:${functionName}`;
const version = '$LATEST';
const qualifiedArn = `${unqualifiedArn}:${version}`;

const backendPort = 8443;
const backendBaseUrl = `https://localhost:${backendPort}/serverless`;
const downstreamDummyPort = 3456;
const downstreamDummyUrl = `http://localhost:${downstreamDummyPort}/`;
const instanaAgentKey = 'aws-lambda-dummy-key';

describe('multiple lambda handler calls', function () {
  this.timeout(config.getTestTimeout());
  const control = new Control({
    faasRuntimePath: path.join(__dirname, '../runtime_mock'),
    handlerDefinitionPath: path.join(__dirname, './lambda'),
    startBackend: true,
    backendPort,
    backendBaseUrl,
    downstreamDummyUrl,
    env: {
      INSTANA_ENDPOINT_URL: backendBaseUrl,
      INSTANA_AGENT_KEY: instanaAgentKey,
      WITH_CONFIG: 'true'
    }
  });
  control.registerTestHooks();

  it('must capture metrics and spans', () =>
    control
      .runHandler()
      .then(() => {
        const duration = Date.now() - control.startedAt;
        expect(duration).to.be.at.most(1000);
        verifyResponse(1);
        return delay(200);
      })
      .then(() => control.runHandler())
      .then(() => {
        const duration = Date.now() - control.startedAt;
        expect(duration).to.be.at.most(1000);
        verifyResponse(2);
        return delay(200);
      })
      .then(() => control.runHandler())
      .then(() => {
        const duration = Date.now() - control.startedAt;
        expect(duration).to.be.at.most(1000);
        verifyResponse(3);
        return Promise.all([
          //
          control.getSpans(),
          control.getRawBundles(),
          control.getRawSpanArrays()
        ]).then(([spans, rawBundles, rawSpanArrays]) => {
          verifySpans(spans);
          expect(rawSpanArrays).to.be.an('array');
          expect(rawSpanArrays).to.have.lengthOf(0);
          expect(rawBundles).to.be.an('array');
          expect(rawBundles).to.have.lengthOf.at.least(3);
          expect(rawBundles).to.have.lengthOf.at.most(4);
        });
      }));

  function verifyResponse(numberOfResults) {
    /* eslint-disable no-console */
    if (control.getLambdaErrors() && control.getLambdaErrors().length > 0) {
      console.log('Unexpected Errors:');
      console.log(JSON.stringify(control.getLambdaErrors()));
    }
    expect(control.getLambdaErrors()).to.be.empty;
    const results = control.getLambdaResults();
    expect(results.length).to.equal(numberOfResults);
    for (let i = 0; i < results.length; i++) {
      const result = control.getLambdaResults()[i];
      expect(result).to.exist;
      const body = result.body;
      expect(body.message).to.equal('Stan says hi!');
    }
  }

  function verifySpans(spans) {
    verifyLambdaEntries(spans);
  }

  function verifyLambdaEntries(spans) {
    return expectExactlyNMatching(spans, 3, [
      span => expect(span.t).to.exist,
      span => expect(span.p).to.not.exist,
      span => expect(span.s).to.exist,
      span => expect(span.n).to.equal('aws.lambda.entry'),
      span => expect(span.k).to.equal(constants.ENTRY),
      span => expect(span.f).to.be.an('object'),
      span => expect(span.f.h).to.not.exist,
      span => expect(span.f.hl).to.be.true,
      span => expect(span.f.cp).to.equal('aws'),
      span => expect(span.f.e).to.equal(qualifiedArn),
      span => expect(span.async).to.not.exist,
      span => expect(span.data.lambda).to.be.an('object'),
      span => expect(span.data.lambda.runtime).to.equal('nodejs'),
      span => expect(span.data.lambda.error).to.not.exist,
      span => expect(span.error).to.not.exist,
      span => expect(span.ec).to.equal(0)
    ]);
  }
});
