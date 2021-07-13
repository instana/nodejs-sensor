/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2021
 */

'use strict';

const { createQueues, deleteQueues, purgeQueues } = require('./sqsUtil');
const semver = require('semver');
const path = require('path');
const { expect } = require('chai');
const { fail } = expect;
const constants = require('@instana/core').tracing.constants;
const supportedVersion = require('@instana/core').tracing.supportedVersion;
const config = require('../../../../../../../core/test/config');
const {
  expectExactlyOneMatching,
  expectAtLeastOneMatching,
  retry,
  delay,
  stringifyItems
} = require('../../../../../../../core/test/test_util');
const ProcessControls = require('../../../../../test_util/ProcessControls');
const globalAgent = require('../../../../../globalAgent');
const { sendMessageWithLegacyHeaders, sendSnsNotificationToSqsQueue } = require('./sendNonInstrumented');
const { verifyHttpRootEntry, verifyHttpExit } = require('@instana/core/test/test_util/common_verifications');
const defaultPrefix = 'https://sqs.us-east-2.amazonaws.com/410797082306/';
const queueUrlPrefix = process.env.SQS_QUEUE_URL_PREFIX || defaultPrefix;

let queueName = 'team_nodejs';

if (process.env.SQS_QUEUE_NAME) {
  queueName = `${process.env.SQS_QUEUE_NAME}${semver.major(process.versions.node)}`;
}

const queueURL = `${queueUrlPrefix}${queueName}`;

let mochaSuiteFn;

const sendingMethods = ['callback', 'promise'];
const receivingMethods = ['callback', 'promise', 'async'];

const getNextSendMethod = require('@instana/core/test/test_util/circular_list').getCircularList(sendingMethods);
const getNextReceiveMethod = require('@instana/core/test/test_util/circular_list').getCircularList(receivingMethods);

if (!supportedVersion(process.versions.node)) {
  mochaSuiteFn = describe.skip;
} else {
  mochaSuiteFn = describe;
}
const retryTime = config.getTestTimeout() * 2;

mochaSuiteFn('tracing/cloud/aws-sdk/v2/sqs', function () {
  this.timeout(config.getTestTimeout() * 4);
  before(async () => {
    await createQueues([queueName, `${queueName}-consumer`, `${queueName}-batch`]);
    // purges queues if they already existed (not deleted from a previous interrupted CI build)
    await purgeQueues([
      `${queueUrlPrefix}${queueName}`,
      `${queueUrlPrefix}${queueName}-consumer`,
      `${queueUrlPrefix}${queueName}-batch`
    ]);
  });

  after(async () => {
    await deleteQueues([
      `${queueUrlPrefix}${queueName}`,
      `${queueUrlPrefix}${queueName}-consumer`,
      `${queueUrlPrefix}${queueName}-batch`
    ]);
  });

  this.timeout(config.getTestTimeout() * 3);

  globalAgent.setUpCleanUpHooks();
  const agentControls = globalAgent.instance;

  describe('tracing enabled, no suppression', function () {
    const senderControls = new ProcessControls({
      appPath: path.join(__dirname, 'sendMessage'),
      port: 3215,
      useGlobalAgent: true,
      env: {
        AWS_SQS_QUEUE_URL: `${queueUrlPrefix}${queueName}`
      }
    });

    const senderControlsSQSConsumer = new ProcessControls({
      appPath: path.join(__dirname, 'sendMessage'),
      port: 3214,
      useGlobalAgent: true,
      env: {
        AWS_SQS_QUEUE_URL: `${queueUrlPrefix}${queueName}-consumer`
      }
    });

    const senderControlsBatch = new ProcessControls({
      appPath: path.join(__dirname, 'sendMessage'),
      port: 3213,
      useGlobalAgent: true,
      env: {
        AWS_SQS_QUEUE_URL: `${queueUrlPrefix}${queueName}-batch`
      }
    });

    ProcessControls.setUpHooksWithRetryTime(retryTime, senderControls);
    ProcessControls.setUpHooksWithRetryTime(retryTime, senderControlsSQSConsumer);
    ProcessControls.setUpHooksWithRetryTime(retryTime, senderControlsBatch);

    receivingMethods.forEach(sqsReceiveMethod => {
      describe(`receiving via ${sqsReceiveMethod} API`, () => {
        const receiverControls = new ProcessControls({
          appPath: path.join(__dirname, 'receiveMessage'),
          port: 3216,
          useGlobalAgent: true,
          env: {
            SQS_RECEIVE_METHOD: sqsReceiveMethod,
            AWS_SQS_QUEUE_URL: `${queueUrlPrefix}${queueName}`
          }
        });

        ProcessControls.setUpHooksWithRetryTime(retryTime, receiverControls);

        [false, 'sender'].forEach(withError => {
          const sqsSendMethod = getNextSendMethod();
          const apiPath = `/send-${sqsSendMethod}`;
          const urlWithParams = withError ? apiPath + '?withError=true' : apiPath;

          it(`send(${sqsSendMethod}); receive(${sqsReceiveMethod}); error: ${!!withError}`, async () => {
            const response = await senderControls.sendRequest({
              method: 'POST',
              path: urlWithParams,
              simple: withError !== 'sender'
            });

            return verify(receiverControls, senderControls, response, apiPath, withError);
          });
        });

        it('falls back to legacy "S" headers if needed. eg: X_INSTANA_ST instead of X_INSTANA_T', async () => {
          const traceId = '1234';
          const spanId = '5678';
          await sendMessageWithLegacyHeaders(queueURL, traceId, spanId);
          return verifySingleSqsEntrySpanWithParent(traceId, spanId);
        });

        it('continues trace from a SNS notification routed to an SQS queue via SNS-to-SQS subscription', async () => {
          const traceId = 'abcdef9876543210';
          const spanId = '9876543210abcdef';
          await sendSnsNotificationToSqsQueue(queueURL, traceId, spanId);
          return verifySingleSqsEntrySpanWithParent(traceId, spanId);
        });

        it(
          'continues trace from a SNS notification routed to an SQS queue via SNS-to-SQS subscription ' +
            '(legacy headers)',
          async () => {
            const traceId = 'abcdef9876543210';
            const spanId = '9876543210abcdef';
            await sendSnsNotificationToSqsQueue(queueURL, traceId, spanId, true);
            return verifySingleSqsEntrySpanWithParent(traceId, spanId);
          }
        );
      });
    });

    describe('sqs-consumer API', () => {
      describe('message processed with success', () => {
        const sqsConsumerControls = new ProcessControls({
          appPath: path.join(__dirname, 'sqs-consumer'),
          port: 3216,
          useGlobalAgent: true,
          env: {
            AWS_SQS_QUEUE_URL: `${queueUrlPrefix}${queueName}-consumer`
          }
        });

        ProcessControls.setUpHooksWithRetryTime(retryTime, sqsConsumerControls);

        const apiPath = '/send-callback';

        it('receives message', async () => {
          const response = await senderControlsSQSConsumer.sendRequest({
            method: 'POST',
            path: apiPath
          });

          return verify(sqsConsumerControls, senderControlsSQSConsumer, response, apiPath, false);
        });
      });

      describe('message not processed with success', () => {
        const sqsConsumerControls = new ProcessControls({
          appPath: path.join(__dirname, 'sqs-consumer'),
          port: 3216,
          useGlobalAgent: true,
          env: {
            AWS_SQS_QUEUE_URL: `${queueUrlPrefix}${queueName}-consumer`,
            AWS_SQS_RECEIVER_ERROR: 'true'
          }
        });

        ProcessControls.setUpHooksWithRetryTime(retryTime, sqsConsumerControls);

        const apiPath = '/send-callback';

        it('fails to receive a message', async () => {
          const response = await senderControlsSQSConsumer.sendRequest({
            method: 'POST',
            path: apiPath
          });

          return verify(sqsConsumerControls, senderControlsSQSConsumer, response, apiPath, 'receiver');
        });
      });
    });

    describe('messages sent in batch', () => {
      receivingMethods.forEach(sqsReceiveMethod => {
        describe(`receiving batched messages: ${sqsReceiveMethod}`, () => {
          const receiverControls = new ProcessControls({
            appPath: path.join(__dirname, 'receiveMessage'),
            port: 3216,
            useGlobalAgent: true,
            env: {
              SQS_RECEIVE_METHOD: sqsReceiveMethod,
              AWS_SQS_QUEUE_URL: `${queueUrlPrefix}${queueName}-batch`
            }
          });

          ProcessControls.setUpHooksWithRetryTime(retryTime, receiverControls);

          const sqsSendMethod = getNextSendMethod();
          const apiPath = `/send-${sqsSendMethod}`;

          it(`sending(${sqsSendMethod}); receiving(${sqsReceiveMethod})`, async () => {
            const response = await senderControlsBatch.sendRequest({
              method: 'POST',
              path: `${apiPath}?isBatch=1`
            });

            return verify(receiverControls, senderControlsBatch, response, apiPath, false, true);
          });
        });
      });
    });

    function verify(receiverControls, _senderControls, response, apiPath, withError, isBatch) {
      if (withError === 'sender') {
        expect(response.data).to.equal("MissingRequiredParameter: Missing required key 'MessageBody' in params");
      } else {
        return retry(() => {
          if (isBatch) {
            verifyResponseAndBatchMessage(response, receiverControls);
          } else {
            verifyResponseAndMessage(response, receiverControls);
          }
          return agentControls
            .getSpans()
            .then(spans => verifySpans(receiverControls, _senderControls, spans, apiPath, null, withError, isBatch));
        }, retryTime);
      }
    }

    function verifySingleSqsEntrySpanWithParent(traceId, spanId) {
      return retry(async () => {
        const spans = await agentControls.getSpans();
        return expectExactlyOneMatching(spans, [
          span => expect(span.t).to.equal(traceId),
          span => expect(span.p).to.equal(spanId),
          span => expect(span.k).to.equal(constants.ENTRY)
        ]);
      }, retryTime);
    }

    function verifySpans(receiverControls, _senderControls, spans, apiPath, messageId, withError, isBatch) {
      const httpEntry = verifyHttpRootEntry({ spans, apiPath, pid: String(_senderControls.getPid()) });
      const sqsExit = verifySQSExit(_senderControls, spans, httpEntry, messageId, withError);

      if (withError !== 'publisher') {
        const sqsEntry = verifySQSEntry(receiverControls, spans, sqsExit, messageId, withError, isBatch);
        verifyHttpExit({ spans, parent: sqsEntry, pid: String(receiverControls.getPid()) });
      }
    }

    function verifySQSEntry(receiverControls, spans, parent, messageId, withError, isBatch) {
      let operation = expectExactlyOneMatching;

      /**
       * When receiving messages in batch, we can have more than one span that matches the criteria because
       * SQS may not send all messages in one batch, thus we cannot guarantee that all messages will be in the batch.
       * More info: https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ReceiveMessage.html
       */
      if (isBatch) {
        operation = expectAtLeastOneMatching;
      }

      return operation(spans, [
        span => expect(span.n).to.equal('sqs'),
        span => expect(span.k).to.equal(constants.ENTRY),
        span => expect(span.t).to.equal(parent.t),
        span => expect(span.p).to.equal(parent.s),
        span => expect(span.f.e).to.equal(String(receiverControls.getPid())),
        span => expect(span.f.h).to.equal('agent-stub-uuid'),
        span => {
          if (withError === 'receiver') {
            expect(span.data.sqs.error).to.match(/Forced error/);
          } else {
            expect(span.data.sqs.error).to.not.exist;
          }
        },
        span => expect(span.ec).to.equal(withError === 'receiver' ? 1 : 0),
        span => expect(span.async).to.not.exist,
        span => expect(span.data).to.exist,
        span => expect(span.data.sqs).to.be.an('object'),
        span => expect(span.data.sqs.sort).to.equal('entry'),
        span => expect(span.data.sqs.queue).to.match(new RegExp(`^${queueUrlPrefix}${queueName}`)),
        span => expect(span.data.sqs.size).to.be.an('number'),
        span => {
          if (!isBatch) {
            // This makes sure that the span end time is logged properly
            expect(span.d).to.greaterThan(1000);
          }
        }
      ]);
    }

    function verifySQSExit(_senderControls, spans, parent, messageId, withError) {
      return expectExactlyOneMatching(spans, [
        span => expect(span.n).to.equal('sqs'),
        span => expect(span.k).to.equal(constants.EXIT),
        span => expect(span.t).to.equal(parent.t),
        span => expect(span.p).to.equal(parent.s),
        span => expect(span.f.e).to.equal(String(_senderControls.getPid())),
        span => expect(span.f.h).to.equal('agent-stub-uuid'),
        span => expect(span.error).to.not.exist,
        span => expect(span.ec).to.equal(withError === 'sender' ? 1 : 0),
        span => expect(span.async).to.not.exist,
        span => expect(span.data).to.exist,
        span => expect(span.data.sqs).to.be.an('object'),
        span => expect(span.data.sqs.sort).to.equal('exit'),
        span => expect(span.data.sqs.queue).to.match(new RegExp(`^${queueUrlPrefix}${queueName}`))
      ]);
    }
  });

  describe('tracing disabled', () => {
    this.timeout(config.getTestTimeout() * 2);

    const senderControls = new ProcessControls({
      appPath: path.join(__dirname, 'sendMessage'),
      port: 3215,
      useGlobalAgent: true,
      tracingEnabled: false,
      env: {
        AWS_SQS_QUEUE_URL: `${queueUrlPrefix}${queueName}`
      }
    });

    ProcessControls.setUpHooksWithRetryTime(retryTime, senderControls);

    const receivingMethod = getNextReceiveMethod();
    describe('sending and receiving', () => {
      const receiverControls = new ProcessControls({
        appPath: path.join(__dirname, 'receiveMessage'),
        port: 3216,
        useGlobalAgent: true,
        tracingEnabled: false,
        env: {
          SQS_RECEIVE_METHOD: receivingMethod,
          AWS_SQS_QUEUE_URL: `${queueUrlPrefix}${queueName}`
        }
      });

      ProcessControls.setUpHooksWithRetryTime(retryTime, receiverControls);

      const sendingMethod = getNextSendMethod();
      it(`should not trace for sending(${sendingMethod}) / receiving(${receivingMethod})`, async () => {
        const response = await senderControls.sendRequest({
          method: 'POST',
          path: `/send-${sendingMethod}`
        });

        return retry(() => verifyResponseAndMessage(response, receiverControls), retryTime)
          .then(() => delay(config.getTestTimeout() / 4))
          .then(() => agentControls.getSpans())
          .then(spans => {
            if (spans.length > 0) {
              fail(`Unexpected spans (AWS SQS suppressed: ${stringifyItems(spans)}`);
            }
          });
      });
    });
  });

  describe('tracing enabled but suppressed', () => {
    const senderControls = new ProcessControls({
      appPath: path.join(__dirname, 'sendMessage'),
      port: 3215,
      useGlobalAgent: true,
      env: {
        AWS_SQS_QUEUE_URL: `${queueUrlPrefix}${queueName}`
      }
    });

    ProcessControls.setUpHooksWithRetryTime(retryTime, senderControls);

    const receivingMethod = getNextReceiveMethod();
    describe('tracing suppressed', () => {
      const receiverControls = new ProcessControls({
        appPath: path.join(__dirname, 'receiveMessage'),
        port: 3216,
        useGlobalAgent: true,
        env: {
          SQS_RECEIVE_METHOD: receivingMethod,
          AWS_SQS_QUEUE_URL: `${queueUrlPrefix}${queueName}`
        }
      });

      ProcessControls.setUpHooksWithRetryTime(retryTime, receiverControls);

      const sendingMethod = getNextSendMethod();
      it(`doesn't trace when sending(${sendingMethod}) and receiving(${receivingMethod})`, async () => {
        const response = await senderControls.sendRequest({
          method: 'POST',
          path: `/send-${sendingMethod}`,
          headers: {
            'X-INSTANA-L': '0'
          }
        });

        return retry(() => {
          verifyResponseAndMessage(response, receiverControls);
        }, retryTime)
          .then(() => delay(config.getTestTimeout() / 4))
          .then(() => agentControls.getSpans())
          .then(spans => {
            if (spans.length > 0) {
              fail(`Unexpected spans (AWS SQS suppressed: ${stringifyItems(spans)}`);
            }
          });
      });
    });
  });

  describe('tracing enabled with wrong queue name', () => {
    const receiverControls = new ProcessControls({
      appPath: path.join(__dirname, 'receiveMessage'),
      port: 3216,
      useGlobalAgent: true,
      env: {
        SQS_RECEIVE_METHOD: 'callback',
        AWS_SQS_QUEUE_URL: queueURL + '-non-existent'
      }
    });

    ProcessControls.setUpHooksWithRetryTime(retryTime, receiverControls);

    it('reports an error span', async () => {
      await retry(() => delay(config.getTestTimeout() / 4), retryTime);
      const spans = await agentControls.getSpans();

      return expectAtLeastOneMatching(spans, [
        span => expect(span.ec).equal(1),
        span => expect(span.data.sqs.error).to.equal('The specified queue does not exist for this wsdl version.')
      ]);
    });
  });
});

function verifyResponseAndMessage(response, receiverControls) {
  expect(response).to.be.an('object');
  const messageId = response.data.MessageId;
  expect(messageId).to.be.a('string');
  const receivedMessages = receiverControls.getIpcMessages();
  expect(receivedMessages).to.be.an('array');
  expect(receivedMessages).to.have.lengthOf.at.least(1);
  const message = receivedMessages.filter(({ MessageId }) => MessageId === messageId)[0];
  expect(message).to.exist;
  expect(message.Body).to.equal('Hello from Node tracer');
  return messageId;
}

function verifyResponseAndBatchMessage(response, receiverControls) {
  expect(response.data).to.be.an('object');
  expect(response.data.Successful.length, 'at least one message in the batch').to.at.least(1);
  const messageId = response.data.Successful.slice(-1)[0].MessageId;
  expect(messageId, 'message id of last successful sent message').to.be.a('string');
  const receivedMessages = receiverControls.getIpcMessages();
  expect(receivedMessages, 'IPC messages must be an array').to.be.an('array');
  expect(receivedMessages, 'IPC messages has at least one item').to.have.lengthOf.at.least(1);
  const message = receivedMessages.filter(({ MessageId }) => MessageId === messageId)[0];
  expect(message, 'received message matches with sent message').to.exist;
  expect(message.Body).to.equal('Hello from Node tracer');
  return messageId;
}
