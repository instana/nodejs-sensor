/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2021
 */

'use strict';

const path = require('path');
const { expect } = require('chai');
const constants = require('@instana/core').tracing.constants;

const Control = require('../Control');
const config = require('../../../serverless/test/config');
const delay = require('../../../core/test/test_util/delay');
const expectExactlyOneMatching = require('../../../core/test/test_util/expectExactlyOneMatching');
const retry = require('../../../serverless/test/util/retry');

const { fail } = expect;

const backendPort = 8443;
const backendBaseUrl = `https://localhost:${backendPort}/serverless`;
const downstreamDummyPort = 3456;
const downstreamDummyUrl = `http://localhost:${downstreamDummyPort}/`;
const instanaAgentKey = 'aws-lambda-dummy-key';

const allTestCases = require('../../../collector/test/tracing/misc/spec_compliance/tracer_compliance_test_cases.json');

const testCasesWithW3cTraceCorrelation = [];
const testCasesWithoutW3cTraceCorrelation = [];
allTestCases.forEach(testDefinition => {
  if (testDefinition.INSTANA_DISABLE_W3C_TRACE_CORRELATION) {
    testCasesWithoutW3cTraceCorrelation.push(testDefinition);
  } else {
    testCasesWithW3cTraceCorrelation.push(testDefinition);
  }
});

describe('AWS Lambda spec compliance', function () {
  this.timeout(config.getTestTimeout());

  [false, true].forEach(w3cTraceCorrelationDisabled => {
    registerSuite(w3cTraceCorrelationDisabled);
  });
});

function registerSuite(w3cTraceCorrelationDisabled) {
  describe('compliance test suite', () => {
    const env = {
      INSTANA_ENDPOINT_URL: backendBaseUrl,
      INSTANA_AGENT_KEY: instanaAgentKey,
      LAMBDA_TRIGGER: 'api-gateway-proxy'
    };

    let testCases;
    if (w3cTraceCorrelationDisabled) {
      env.INSTANA_DISABLE_W3C_TRACE_CORRELATION = 'a non-empty string';
      testCases = testCasesWithoutW3cTraceCorrelation;
    } else {
      testCases = testCasesWithW3cTraceCorrelation;
    }

    const control = new Control({
      faasRuntimePath: path.join(__dirname, '../runtime_mock'),
      handlerDefinitionPath: path.join(__dirname, './lambda.js'),
      startBackend: true,
      backendPort,
      backendBaseUrl,
      downstreamDummyUrl,
      env
    });
    control.registerTestHooks();

    testCases.forEach(testDefinition => {
      const label =
        `${testDefinition.index}: ${testDefinition['Scenario/incoming headers']} -> ` +
        `${testDefinition['What to do?']}`;
      it(label, async () => {
        const valuesForPlaceholders = {};
        const headers = {};
        [
          'X-INSTANA-T in',
          'X-INSTANA-S in',
          'X-INSTANA-L in',
          'X-INSTANA-SYNTHETIC in',
          'traceparent in',
          'tracestate in'
        ].forEach(headerName => {
          const actualHeaderName = headerName.slice(0, -3);
          const headerValue = testDefinition[headerName];
          if (headerValue) {
            headers[actualHeaderName] = headerValue;
            // eslint-disable-next-line no-console
            console.log(`setting ${actualHeaderName} to ${headerValue}`);
          } else {
            // eslint-disable-next-line no-console
            console.log(`not setting ${actualHeaderName}`);
          }
        });

        const suppressed = testDefinition['X-INSTANA-L in'] === '0';

        await control.runHandler({
          event: {
            resource: '/start',
            path: '/start',
            httpMethod: 'POST',
            headers
          }
        });

        const errors = control.getLambdaErrors();
        if (errors.length > 0) {
          fail(`The Lambda invocation produced unexpected errors ${JSON.stringify(errors, null, 2)}`);
        }
        const results = control.getLambdaResults();
        expect(results).is.an('array');
        expect(results).to.have.length(1);
        const response = results[0];

        const expectedServerTimingValue = testDefinition['Server-Timing'];
        const responseHeaders = response.headers || {};
        const actualServerTimingValue = responseHeaders['Server-Timing'];
        if (expectedServerTimingValue && expectedServerTimingValue.includes('$')) {
          expect(actualServerTimingValue).to.exist;
          parseForPlaceholders(valuesForPlaceholders, expectedServerTimingValue, actualServerTimingValue);
          expect(actualServerTimingValue).to.exist;
        } else if (expectedServerTimingValue) {
          expect(actualServerTimingValue).to.equal(expectedServerTimingValue);
        }

        const responseBody = response.body;
        verifyHttpHeadersOnDownstreamRequest(testDefinition, valuesForPlaceholders, responseBody);

        if (suppressed) {
          await delay(500);
          const spans = await control.getSpans();
          expect(spans).to.have.lengthOf(0);
        } else {
          await retry(async () => {
            const spans = await control.getSpans();
            verifyHttpEntry(testDefinition, valuesForPlaceholders, spans, '/start');
            verifyHttpExit(testDefinition, valuesForPlaceholders, spans);
          });
        }
      });
    });
  });
}

function parseForPlaceholders(valuesForPlaceholders, template, value) {
  // I'm sorry, this is ugly and complicated. To ease the pain, let's follow along with an example. Assuming we have:
  // template = 00-0000000000000000$new_64_bit_trace_id-$new_span_id_2-01
  // value = 00-0000000000000000b9e374754ca092b9-de54a2e7e1ceffc4-01
  // Then we will get
  // placeholdersInString = [ '$new_64_bit_trace_id', '$new_span_id_2' ]
  const placeholdersInString = template.match(/(\$[a-z0-9_]*)/g);

  // Now escape "$" characters so we they are used as literals in the regex:
  // escapedPlaceholdersInString = [ '\\$new_64_bit_trace_id', '\\$new_span_id_2' ]
  const escapedPlaceholdersInString = placeholdersInString.map(tpl => tpl.replace('$', '\\$'));
  const placeholderPattern = `^(.*)${escapedPlaceholdersInString.join('(.*)')}(.*)$`;
  const placeholderRegex = new RegExp(placeholderPattern);
  let fixedLiteralsMatchResult = placeholderRegex.exec(template);
  if (!fixedLiteralsMatchResult) {
    throw new Error(`No placeholder match result ${template}.`);
  }
  // fixedLiteralsMatchResult = [ '00-0000000000000000', '-', '-01' ]
  fixedLiteralsMatchResult = fixedLiteralsMatchResult.slice(1);

  // valuesPattern = '^00-0000000000000000(.*)-(.*)-01$'
  const valuesPattern = `^${fixedLiteralsMatchResult.join('(.*)')}$`;
  const valuesRegex = new RegExp(valuesPattern);
  let valuesMatchResult = valuesRegex.exec(value);
  if (!valuesMatchResult) {
    throw new Error(`I could not match the value ${value} against the template ${template}.`);
  }
  // valuesMatchResult = [ '3124d02b3e5b1531', 'e16a9d4443b7e2d1' ]
  valuesMatchResult = valuesMatchResult.slice(1);

  for (let i = 0; i < placeholdersInString.length; i++) {
    const key = placeholdersInString[i];
    const existingValue = valuesForPlaceholders[key];
    const newValue = valuesMatchResult[i];
    if (existingValue) {
      expect(
        newValue,
        `The placeholder ${key} had the value ${existingValue} earlier but now it has the value ${newValue}. ` +
          'The same placeholders needs to always have the same value throughout one single test case.'
      ).to.equal(existingValue);
    } else {
      valuesForPlaceholders[placeholdersInString[i]] = newValue;
    }
  }

  // valuesForPlaceholders = {
  //   '$new_64_bit_trace_id': '3124d02b3e5b1531',
  //   '$new_span_id_2': 'e16a9d4443b7e2d1'
  // }
}

function verifyHttpEntry(testDefinition, valuesForPlaceholders, spans, url) {
  const expectations = [
    span => expect(span.n).to.equal('aws.lambda.entry'),
    span => expect(span.k).to.equal(constants.ENTRY),
    span => expect(span.ec).to.equal(0),
    span => expect(span.t).to.be.a('string'),
    span => expect(span.s).to.be.a('string'),
    span => expect(span.data.http.method).to.equal('POST'),
    span => expect(span.data.http.url).to.equal(url),
    span => expect(span.data.http.status).to.equal(200)
  ];

  [
    'entrySpan.t',
    'entrySpan.p',
    'entrySpan.s',
    'entrySpan.ia',
    'entrySpan.tp',
    'entrySpan.lt',
    'entrySpan.crid',
    'entrySpan.crtp',
    'entrySpan.sy'
  ].forEach(definitionAttribute => {
    const spanAttribute = definitionAttribute.substring(definitionAttribute.indexOf('.') + 1);
    addExpectation(expectations, testDefinition, valuesForPlaceholders, definitionAttribute, spanAttribute);
  });

  // span.fp is no longer supported
  expectations.push(span => expect(span.fp).to.not.exist);

  return expectExactlyOneMatching(spans, expectations);
}

function verifyHttpExit(testDefinition, valuesForPlaceholders, spans) {
  const expectations = [
    span => expect(span.n).to.equal('node.http.client'),
    span => expect(span.k).to.equal(constants.EXIT),
    span => expect(span.ec).to.equal(0),
    span => expect(span.t).to.be.a('string'),
    span => expect(span.s).to.be.a('string'),
    span => expect(span.data.http.method).to.equal('GET'),
    span => expect(span.data.http.url).to.equal(`http://localhost:${downstreamDummyPort}/`),
    span => expect(span.data.http.status).to.equal(200)
  ];
  [
    'exitSpan.t',
    'exitSpan.p',
    'exitSpan.s',
    'exitSpan.ia',
    'exitSpan.tp',
    'exitSpan.lt',
    'exitSpan.crid',
    'exitSpan.crtp',
    'exitSpan.sy'
  ].forEach(definitionAttribute => {
    const spanAttribute = definitionAttribute.substring(definitionAttribute.indexOf('.') + 1);
    addExpectation(expectations, testDefinition, definitionAttribute, spanAttribute);
  });

  return expectExactlyOneMatching(spans, expectations);
}

function addExpectation(expectations, testDefinition, valuesForPlaceholders, definitionAttribute, spanAttribute) {
  const expectedValue = testDefinition[definitionAttribute];
  const msg = `value for span attribute ${spanAttribute}`;
  if (expectedValue == null || expectedValue === '') {
    expectations.push(span => expect(span[spanAttribute], msg).to.not.exist);
  } else if (expectedValue && typeof expectedValue === 'object') {
    expectations.push(span =>
      expect(
        span[spanAttribute],
        `${msg}, actual: ${JSON.stringify(span[spanAttribute])} vs. expected ${JSON.stringify(expectedValue)}`
      ).to.deep.equal(expectedValue)
    );
  } else if (expectedValue === true) {
    expectations.push(span => expect(span[spanAttribute]).to.be.true);
  } else if (expectedValue === false) {
    expectations.push(span => expect(span[spanAttribute]).to.be.false);
  } else if (expectedValue && expectedValue.startsWith('$')) {
    expectations.push(span => {
      expect(span[spanAttribute], msg).to.exist;
      parseForPlaceholders(valuesForPlaceholders, expectedValue, span[spanAttribute]);
    });
  } else if (expectedValue) {
    expectations.push(span => expect(span[spanAttribute], msg).to.equal(expectedValue));
  } else {
    throw new Error(
      `Expected value for ${definitionAttribute} has an unexpected shape: ${expectedValue}. ` +
        'I cannot add an expectation for this.'
    );
  }
}

function verifyHttpHeadersOnDownstreamRequest(testDefinition, valuesForPlaceholders, responseBody) {
  [
    //
    'X-INSTANA-T out',
    'X-INSTANA-S out',
    'X-INSTANA-L out',
    'traceparent out',
    'tracestate out'
  ].forEach(headerName => {
    const actualHeaderName = headerName.slice(0, -4);
    const actualValue = responseBody[actualHeaderName];
    const expectedHeaderValue = testDefinition[headerName];
    const msg = `value for outgoing HTTP header ${actualHeaderName} going downstream`;
    if (!expectedHeaderValue) {
      expect(actualValue, msg).to.not.exist;
    } else if (expectedHeaderValue.includes('$')) {
      expect(actualValue, msg).to.exist;
      parseForPlaceholders(valuesForPlaceholders, expectedHeaderValue, actualValue);
    } else {
      expect(actualValue, msg).to.equal(expectedHeaderValue);
    }
  });
}
