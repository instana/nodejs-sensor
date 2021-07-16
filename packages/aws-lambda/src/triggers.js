/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2019
 */

'use strict';

const { constants: tracingConstants, tracingHeaders, util: tracingUtil } = require('@instana/core').tracing;
const { secrets } = require('@instana/core');
const zlib = require('zlib');

const { captureHeaders } = require('./capture_headers');

const maxCloudwatchEventsResources = 3;
const maxCloudwatchEventsLength = 200;
const maxCloudwatchLogsEvents = 3;
const maxCloudwatchLogsEventLength = 200;
const maxS3Records = 3;
const maxS3ObjectKeyLength = 200;
const maxSQSRecords = 3;

exports.enrichSpanWithTriggerData = function enrichSpanWithTriggerData(event, context, span) {
  if (isApiGatewayProxyTrigger(event)) {
    span.data.lambda.trigger = 'aws:api.gateway';
    extractHttpFromApiGatewwayProxyEvent(event, span);
    return;
  } else if (isApplicationLoadBalancerTrigger(event)) {
    span.data.lambda.trigger = 'aws:application.load.balancer';
    extractHttpFromApplicationLoadBalancerEvent(event, span);
    return;
  } else if (isCloudwatchEventTrigger(event)) {
    span.data.lambda.trigger = 'aws:cloudwatch.events';
    extractEventFromCloudwatchEvent(event, span);
    return;
  } else if (isCloudwatchLogsTrigger(event)) {
    span.data.lambda.trigger = 'aws:cloudwatch.logs';
    extractEventFromCloudwatchLogs(event, span);
    return;
  } else if (isS3Trigger(event)) {
    span.data.lambda.trigger = 'aws:s3';
    extractEventFromS3(event, span);
    return;
  } else if (isSQSTrigger(event)) {
    span.data.lambda.trigger = 'aws:sqs';
    extractEventFromSQS(event, span);
    return;
  } else if (isInvokeFunction(context)) {
    span.data.lambda.trigger = 'aws:lambda.invoke';
    return;
  }

  // When an API Gateway is used without the "Use Lambda Proxy" setting, the body from the HTTP request is forwarded
  // as-is as the event. If there is no HTTP body, an empty object is passed. There is no way of differentiating such an
  // invocation reliably by inspecting the event object. Thus, we assume all invocations that we cannot identify as
  // something else are in fact API gateway calls without the lambda proxy setting.
  span.data.lambda.trigger = 'aws:api.gateway.noproxy';
};

function isApiGatewayProxyTrigger(event) {
  // Note: An application load balancer event also has event.path and event.httpMethod but it does not have
  // event.resource.
  return event.resource != null && event.path != null && event.httpMethod != null;
}

function extractHttpFromApiGatewwayProxyEvent(event, span) {
  // Remark: We never extract host headers for Lambda entries even if we could sometimes, because they are of no
  // interest.
  span.data.http = {
    method: event.httpMethod,
    url: event.path,
    path_tpl: event.resource,
    params: readHttpQueryParams(event),
    header: captureHeaders(event)
  };
}

function readHttpQueryParams(event) {
  if (event.multiValueQueryStringParameters) {
    return Object.keys(event.multiValueQueryStringParameters)
      .map(key =>
        event.multiValueQueryStringParameters[key].reduce((paramsPerKey, value) => {
          if (secrets.isSecret(key)) {
            paramsPerKey.push(`${key}=<redacted>`);
          } else {
            paramsPerKey.push(`${key}=${value}`);
          }
          return paramsPerKey;
        }, [])
      )
      .reduce((flattendParamsArray, paramsForOneKey) => flattendParamsArray.concat(paramsForOneKey), [])
      .join('&');
  } else if (event.queryStringParameters) {
    return Object.keys(event.queryStringParameters)
      .map(key => {
        if (secrets.isSecret(key)) {
          return `${key}=<redacted>`;
        }
        return `${key}=${event.queryStringParameters[key]}`;
      })
      .join('&');
  }
  return undefined;
}

function isApplicationLoadBalancerTrigger(event) {
  return event.requestContext && event.requestContext.elb;
}

function extractHttpFromApplicationLoadBalancerEvent(event, span) {
  // Remark: We never extract host headers for Lambda entries even if we could some times, because they are of no
  // interest.
  span.data.http = {
    method: event.httpMethod,
    url: event.path,
    params: readHttpQueryParams(event),
    header: captureHeaders(event)
  };
}

function isCloudwatchEventTrigger(event) {
  return event.source === 'aws.events' && event['detail-type'] === 'Scheduled Event';
}

function extractEventFromCloudwatchEvent(event, span) {
  span.data.lambda.cw = {
    events: {}
  };
  span.data.lambda.cw.events.id = event.id;
  if (Array.isArray(event.resources) && event.resources.length > 0) {
    // we arbitrarily fetch at most the first three resources
    span.data.lambda.cw.events.resources = event.resources
      .slice(0, maxCloudwatchEventsResources)
      .map(cwEvent =>
        cwEvent.length > maxCloudwatchEventsLength ? `${cwEvent.substring(0, maxCloudwatchEventsLength)}…` : cwEvent
      );
    span.data.lambda.cw.events.more = event.resources.length > maxCloudwatchEventsResources;
  }
}

function isCloudwatchLogsTrigger(event) {
  return event.awslogs != null;
}

function extractEventFromCloudwatchLogs(event, span) {
  span.data.lambda.cw = {
    logs: {}
  };
  const payload = Buffer.from(event.awslogs.data, 'base64');
  zlib.gunzip(payload, (err, decodedEvent) => {
    if (err && err.message) {
      span.data.lambda.cw.logs.decodingError = `Could not decode the Cloudwatch logs payload: ${err.message}`;
    } else if (err) {
      span.data.lambda.cw.logs.decodingError = 'Could not decode the Cloudwatch logs payload.';
    } else {
      try {
        decodedEvent = JSON.parse(decodedEvent.toString('ascii'));
      } catch (err2) {
        span.data.lambda.cw.logs.decodingError = `Could not parse the Cloudwatch logs payload: ${err2.message}`;
      }
      span.data.lambda.cw.logs.group = decodedEvent.logGroup;
      span.data.lambda.cw.logs.stream = decodedEvent.logStream;
      // we arbitrarily fetch at most the first three log events
      if (Array.isArray(decodedEvent.logEvents) && decodedEvent.logEvents.length > 0) {
        span.data.lambda.cw.logs.events = decodedEvent.logEvents
          .slice(0, maxCloudwatchLogsEvents)
          .map(evnt => evnt.message)
          .map(msg =>
            msg.length > maxCloudwatchLogsEventLength ? `${msg.substring(0, maxCloudwatchLogsEventLength)}…` : msg
          );
        span.data.lambda.cw.logs.more = decodedEvent.logEvents.length > maxCloudwatchLogsEvents;
      }
    }
  });
}

function isS3Trigger(event) {
  return Array.isArray(event.Records) && event.Records.length > 0 && event.Records[0].eventSource === 'aws:s3';
}

function extractEventFromS3(event, span) {
  span.data.lambda.s3 = {
    events: event.Records.slice(0, maxS3Records).map(s3Record => ({
      event: s3Record.eventName,
      bucket: s3Record.s3 && s3Record.s3.bucket ? s3Record.s3.bucket.name : undefined,
      object: s3RecordToObject(s3Record)
    }))
  };
  span.data.lambda.s3.more = event.Records.length > maxS3Records;
}

function s3RecordToObject(s3Record) {
  if (s3Record.s3 && s3Record.s3.object && s3Record.s3.object.key) {
    return s3Record.s3.object.key.length > maxS3ObjectKeyLength
      ? `${s3Record.s3.object.key.substring(0, maxS3ObjectKeyLength)}…`
      : s3Record.s3.object.key;
  } else {
    return undefined;
  }
}

function isSQSTrigger(event) {
  return Array.isArray(event.Records) && event.Records.length > 0 && event.Records[0].eventSource === 'aws:sqs';
}

function extractEventFromSQS(event, span) {
  span.data.lambda.sqs = {
    messages: event.Records.slice(0, maxSQSRecords).map(sqsRecord => ({
      queue: sqsRecord.eventSourceARN
    }))
  };
  span.data.lambda.sqs.more = event.Records.length > maxSQSRecords;
}

function isInvokeFunction(context) {
  const custom = readClientContextCustom(context);
  return custom && (custom['x-instana-l'] || custom['x-instana-s'] || custom['x-instana-t']);
}

exports.readTraceCorrelationData = function readTraceCorrelationData(event, context) {
  let traceCorrelationData;

  traceCorrelationData = readTraceCorrelationFromClientContextCustom(context);
  if (hasFoundTraceCorrelationData(traceCorrelationData)) {
    return traceCorrelationData;
  }

  traceCorrelationData = readTraceCorrelationFromSqs(event);
  if (hasFoundTraceCorrelationData(traceCorrelationData)) {
    return traceCorrelationData;
  }

  // readTraceCorrelationFromHttpHeaders will always return values as long as there is a headers attribute of type
  // object, even if no Instana headers are present (because it uses tracingHeaders.fromHeaders under the hood).
  // Therefore readTraceCorrelationFromHttpHeaders should come last, after checking all other sources of trace
  // correlation (client context, SQS, ...).
  traceCorrelationData = readTraceCorrelationFromHttpHeaders(event);
  if (hasFoundTraceCorrelationData(traceCorrelationData)) {
    return traceCorrelationData;
  }

  // No trace correlation data has been found, so we return an empty object. This implies that a new trace will be
  // started.
  return {};
};

function readTraceCorrelationFromHttpHeaders(event) {
  if (event.headers && typeof event.headers === 'object') {
    return tracingHeaders.fromHeaders(event.headers);
  }
  return {};
}

function readClientContextCustom(context) {
  // The Node.js AWS SDK documentation expects for Custom, with capital "C", but the same is not explicitly said for
  // other languages, so we test both.
  return (
    (context && context.clientContext && context.clientContext.Custom) ||
    (context && context.clientContext && context.clientContext.custom)
  );
}

function readTraceCorrelationFromClientContextCustom(context) {
  const traceCorrelationData = {};
  const custom = readClientContextCustom(context);
  if (custom) {
    if (custom[tracingConstants.traceLevelHeaderNameLowerCase]) {
      traceCorrelationData.level = custom[tracingConstants.traceLevelHeaderNameLowerCase];
    }
    if (custom[tracingConstants.spanIdHeaderNameLowerCase]) {
      traceCorrelationData.parentId = custom[tracingConstants.spanIdHeaderNameLowerCase];
    }
    if (custom[tracingConstants.traceIdHeaderNameLowerCase]) {
      traceCorrelationData.traceId = custom[tracingConstants.traceIdHeaderNameLowerCase];
    }
  }
  return traceCorrelationData;
}

function readTraceCorrelationFromSqs(event) {
  let traceCorrelationData = {};
  if (isSQSTrigger(event)) {
    const sqsMessageAttributes = event.Records[0].messageAttributes;
    if (sqsMessageAttributes) {
      traceCorrelationData = readTraceCorrelationFromSqsAttributes(sqsMessageAttributes);
      if (hasFoundTraceCorrelationData(traceCorrelationData)) {
        return traceCorrelationData;
      }
    }

    const sqsMessageBody = event.Records[0].body;
    // Parsing the message body introduces a tiny overhead which we want to avoid unless we are sure that the incoming
    // message actually has tracing attributes. Thus some preliminary, cheaper checks are executed first.
    if (
      typeof sqsMessageBody === 'string' &&
      sqsMessageBody.startsWith('{') &&
      sqsMessageBody.includes('"Type":"Notification"') &&
      tracingConstants.snsSqsInstanaHeaderPrefixRegex.test(sqsMessageBody)
    ) {
      try {
        const parsedSqsMessageBody = JSON.parse(sqsMessageBody);
        const snsAttributes = parsedSqsMessageBody && parsedSqsMessageBody.MessageAttributes;
        if (snsAttributes) {
          traceCorrelationData = readTraceCorrelationFromSqsAttributes(snsAttributes);
          if (hasFoundTraceCorrelationData(traceCorrelationData)) {
            return traceCorrelationData;
          }
        }
      } catch (e) {
        // The attempt to parse the message body as JSON failed, so this is not an SQS message resulting from an SNS
        // notification (SNS-to-SQS subscription), in which case we are not interested in the body. Ignore the error and
        // move on.
      }
    }
  }
  return traceCorrelationData;
}

function readTraceCorrelationFromSqsAttributes(attributes) {
  const traceCorrelationData = {};
  traceCorrelationData.traceId = readSqsMessageAttributeWithFallback(
    attributes,
    tracingConstants.sqsAttributeNames.TRACE_ID,
    tracingConstants.sqsAttributeNames.LEGACY_TRACE_ID
  );
  traceCorrelationData.parentId = readSqsMessageAttributeWithFallback(
    attributes,
    tracingConstants.sqsAttributeNames.SPAN_ID,
    tracingConstants.sqsAttributeNames.LEGACY_SPAN_ID
  );
  traceCorrelationData.level = readSqsMessageAttributeWithFallback(
    attributes,
    tracingConstants.sqsAttributeNames.LEVEL,
    tracingConstants.sqsAttributeNames.LEGACY_LEVEL
  );
  return traceCorrelationData;
}

function readSqsMessageAttributeWithFallback(messageAttributes, key, keyFallback) {
  return (
    readSqsStringMessageAttribute(messageAttributes, key) ||
    readSqsStringMessageAttribute(messageAttributes, keyFallback)
  );
}

function readSqsStringMessageAttribute(messageAttributes, key) {
  const attribute = tracingUtil.readAttribCaseInsensitive(messageAttributes, key);
  // attribute.stringValue is used by SQS message attributes, attribute.Value is used by SNS-to-SQS.
  if (attribute && (attribute.stringValue || attribute.Value)) {
    return attribute.stringValue || attribute.Value;
  }
  return null;
}

function hasFoundTraceCorrelationData(traceCorrelationData) {
  return traceCorrelationData.traceId || traceCorrelationData.parentId || traceCorrelationData.level;
}
