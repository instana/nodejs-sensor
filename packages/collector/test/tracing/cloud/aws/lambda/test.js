/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2021
 */

'use strict';

// const semver = require('semver');
// const path = require('path');
// const { expect } = require('chai');
// const { fail } = expect;
// const constants = require('@instana/core').tracing.constants;
// const supportedVersion = require('@instana/core').tracing.supportedVersion;
// const config = require('../../../../../../core/test/config');
// const { expectExactlyOneMatching, retry, stringifyItems, delay } = require('../../../../../../core/test/test_util');
// const ProcessControls = require('../../../../test_util/ProcessControls');
// const globalAgent = require('../../../../globalAgent');

// let functionName = 'nodejs-team';

// if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
//   functionName = `${process.env.AWS_LAMBDA_FUNCTION_NAME}${semver.major(process.versions.node)}`;
// }

// let mochaSuiteFn;

// const operationsInfo = {
//   createTable: 'create',
//   listTables: 'list',
// };

// const withErrorOptions = [false, true];

// const requestMethods = ['Callback', 'Promise'];
// const availableOperations = [
//   'invoke',
//   'invokeAsync',
// ];

// if (!supportedVersion(process.versions.node)) {
//   mochaSuiteFn = describe.skip;
// } else {
//   mochaSuiteFn = describe;
// }

// const retryTime = config.getTestTimeout() * 2;

// mochaSuiteFn('tracing/cloud/aws/dynamodb', function () {
//   this.timeout(config.getTestTimeout() * 3);

//   globalAgent.setUpCleanUpHooks();
//   const agentControls = globalAgent.instance;

//   describe('tracing enabled, no suppression', function () {
//     const appControls = new ProcessControls({
//       appPath: path.join(__dirname, 'app'),
//       port: 3215,
//       useGlobalAgent: true,
//       env: {
//         AWS_DYNAMODB_TABLE_NAME: functionName
//       }
//     });

//     ProcessControls.setUpHooksWithRetryTime(retryTime, appControls);
//     withErrorOptions.forEach(withError => {
//       requestMethods.forEach(requestMethod => {
//         describe(`getting result with: ${requestMethod}; with error: ${withError ? 'yes' : 'no'}`, () => {
//           availableOperations.forEach(operation => {
//             it(`operation: ${operation}`, async () => {
//               const withErrorOption = withError ? '?withError=1' : '';
//               const apiPath = `/${operation}/${requestMethod}`;

//               const response = await appControls.sendRequest({
//                 method: 'GET',
//                 path: `${apiPath}${withErrorOption}`,
//                 simple: withError === false
//               });

//               return verify(appControls, response, apiPath, operation, withError);
//             });
//           });
//         });
//       });
//     });

//     function verify(controls, response, apiPath, operation, withError) {
//       return retry(() => {
//         return agentControls.getSpans().then(spans => verifySpans(controls, spans, apiPath, operation, withError));
//       }, retryTime);
//     }

//     function verifySpans(controls, spans, apiPath, operation, withError) {
//       const httpEntry = verifyHttpEntry(spans, apiPath, controls);
//       verifyDynamoDBExit(spans, httpEntry, operation, withError);

//       if (!withError) {
//         verifyHttpExit(spans, httpEntry, controls);
//       }
//     }

//     function verifyHttpEntry(spans, apiPath, controls) {
//       return expectExactlyOneMatching(spans, [
//         span => expect(span.p).to.not.exist,
//         span => expect(span.k).to.equal(constants.ENTRY),
//         span => expect(span.f.e).to.equal(String(controls.getPid())),
//         span => expect(span.f.h).to.equal('agent-stub-uuid'),
//         span => expect(span.n).to.equal('node.http.server'),
//         span => expect(span.data.http.url).to.equal(apiPath)
//       ]);
//     }

//     function verifyHttpExit(spans, parentSpan, controls) {
//       return expectExactlyOneMatching(spans, [
//         span => expect(span.t).to.equal(parentSpan.t),
//         span => expect(span.p).to.equal(parentSpan.s),
//         span => expect(span.k).to.equal(constants.EXIT),
//         span => expect(span.f.e).to.equal(String(controls.getPid())),
//         span => expect(span.f.h).to.equal('agent-stub-uuid'),
//         span => expect(span.n).to.equal('node.http.client')
//       ]);
//     }

//     function verifyDynamoDBExit(spans, parent, operation, withError) {
//       return expectExactlyOneMatching(spans, [
//         span => expect(span.n).to.equal('dynamodb'),
//         span => expect(span.k).to.equal(constants.EXIT),
//         span => expect(span.t).to.equal(parent.t),
//         span => expect(span.p).to.equal(parent.s),
//         span => expect(span.f.e).to.equal(String(appControls.getPid())),
//         span => expect(span.f.h).to.equal('agent-stub-uuid'),
//         span => expect(span.error).to.not.exist,
//         span => expect(span.ec).to.equal(withError ? 1 : 0),
//         span => expect(span.async).to.not.exist,
//         span => expect(span.data).to.exist,
//         span => expect(span.data.dynamodb).to.be.an('object'),
//         span => expect(span.data.dynamodb.op).to.equal(operationsInfo[operation]),
//         span => expect(span.data.dynamodb.table).to.equal(operation !== 'listTables' ? functionName : undefined)
//       ]);
//     }
//   });

//   describe('tracing disabled', () => {
//     this.timeout(config.getTestTimeout() * 2);

//     const appControls = new ProcessControls({
//       appPath: path.join(__dirname, 'app'),
//       port: 3215,
//       useGlobalAgent: true,
//       tracingEnabled: false,
//       env: {
//         AWS_DYNAMODB_TABLE_NAME: functionName
//       }
//     });

//     ProcessControls.setUpHooksWithRetryTime(retryTime, appControls);

//     requestMethods.forEach(requestMethod => {
//       describe(`attempt to get result with: ${requestMethod}`, () => {
//         availableOperations.forEach(operation => {
//           it(`should not trace (${operation})`, async () => {
//             await appControls.sendRequest({
//               method: 'GET',
//               path: `/${operation}/${requestMethod}`
//             });
//             return retry(() => delay(config.getTestTimeout() / 4))
//               .then(() => agentControls.getSpans())
//               .then(spans => {
//                 if (spans.length > 0) {
//                   fail(`Unexpected spans (AWS DynamoDB suppressed: ${stringifyItems(spans)}`);
//                 }
//               });
//           });
//         });
//       });
//     });
//   });

//   describe('tracing enabled but suppressed', () => {
//     const appControls = new ProcessControls({
//       appPath: path.join(__dirname, 'app'),
//       port: 3215,
//       useGlobalAgent: true,
//       env: {
//         AWS_DYNAMODB_TABLE_NAME: functionName
//       }
//     });

//     ProcessControls.setUpHooksWithRetryTime(retryTime, appControls);

//     requestMethods.forEach(requestMethod => {
//       describe(`attempt to get result with: ${requestMethod}`, () => {
//         availableOperations.forEach(operation => {
//           it(`should not trace (${operation})`, async () => {
//             await appControls.sendRequest({
//               suppressTracing: true,
//               method: 'GET',
//               path: `/${operation}/${requestMethod}`
//             });

//             return retry(() => delay(config.getTestTimeout() / 4), retryTime)
//               .then(() => agentControls.getSpans())
//               .then(spans => {
//                 if (spans.length > 0) {
//                   fail(`Unexpected spans (AWS DynamoDB suppressed: ${stringifyItems(spans)}`);
//                 }
//               });
//           });
//         });
//       });
//     });
//   });
// });
