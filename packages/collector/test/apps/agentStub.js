/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2016
 */

'use strict';

const bodyParser = require('body-parser');
const bunyan = require('bunyan');
const express = require('express');
const _ = require('lodash');
// const morgan = require('morgan');
const app = express();

const deepMerge = require('../../../core/src/util/deepMerge');

const logger = bunyan.createLogger({ name: 'agent-stub', pid: process.pid });
// logger.level('debug');

const port = process.env.AGENT_PORT || 42699;
const extraHeaders = process.env.EXTRA_HEADERS ? process.env.EXTRA_HEADERS.split(',') : [];
const secretsMatcher = process.env.SECRETS_MATCHER ? process.env.SECRETS_MATCHER : 'contains-ignore-case';
const secretsList = process.env.SECRETS_LIST ? process.env.SECRETS_LIST.split(',') : ['key', 'pass', 'secret'];
const dropAllData = process.env.DROP_DATA === 'true';
const logTraces = process.env.LOG_TRACES === 'true';
const logProfiles = process.env.LOG_PROFILES === 'true';
const rejectTraces = process.env.REJECT_TRACES === 'true';
const startUpDelay = process.env.STARTUP_DELAY ? parseInt(process.env.STARTUP_DELAY, 10) : null;
const startTime = Date.now();
const doesntHandleProfiles = process.env.DOESNT_HANDLE_PROFILES === 'true';
const tracingMetrics = process.env.TRACING_METRICS !== 'false';
const enableSpanBatching = process.env.ENABLE_SPANBATCHING === 'true';

let discoveries = {};
let rejectAnnounceAttempts = 0;
let requests = {};
let receivedData = resetReceivedData();

// We usually do not activate morgan in the agent stub because it creates a lot of noise with little benefit. Activate
// it on demand if required.
// if (process.env.WITH_STDOUT) {
//   app.use(morgan(`> Agent Stub [:date[iso]] (${process.pid}):\t:method :url`, { immediate: true }));
//   app.use(morgan(`< Agent Stub [:date[iso]] (${process.pid}):\t:method :url :status`));
// }

app.use(
  bodyParser.json({
    limit: '10mb'
  })
);

app.use((req, res, next) => {
  res.set('server', 'Instana Agent');
  next();
});

app.get('/', (req, res) => {
  res.send('OK');
});

app.put('/com.instana.plugin.nodejs.discovery', (req, res) => {
  const pid = req.body.pid;

  if (rejectAnnounceAttempts > 0) {
    rejectAnnounceAttempts--;
    logger.debug('Rejecting new discovery %s announce attempt test retry mechanism', pid);
    return res.sendStatus(404);
  }

  if (startUpDelay && Date.now() - startTime < startUpDelay) {
    logger.warn('Rejecting new discovery announce attempt due to artificial startup delay', pid);
    return res.sendStatus(404);
  }

  discoveries[pid] = req.body;
  logger.debug('New discovery %s with params', pid, req.body);

  const response = {
    agentUuid: 'agent-stub-uuid',
    pid,
    extraHeaders,
    secrets: {
      matcher: secretsMatcher,
      list: secretsList
    }
  };

  if (enableSpanBatching) {
    response.spanBatchingEnabled = true;
  }

  res.send(response);
});

app.head(
  '/com.instana.plugin.nodejs.:pid',
  checkExistenceOfKnownPid(function handleAnnounceCheck(req, res) {
    logger.debug('Got announce check for PID %s', req.params.pid);
    res.send('OK');
  })
);

app.post(
  '/com.instana.plugin.nodejs.:pid',
  checkExistenceOfKnownPid(function handleEntityData(req, res) {
    const pid = req.params.pid;

    if (startUpDelay && Date.now() - startTime < startUpDelay) {
      logger.warn('Rejecting entity data for pid %s due to artificial startup delay.', pid);
      return res.sendStatus(404);
    }

    if (!dropAllData) {
      receivedData.metrics.push({
        pid: parseInt(pid, 10),
        time: Date.now(),
        data: req.body
      });
      aggregateMetrics(req.params.pid, req.body);
    }

    const requestsForPid = requests[pid] || [];
    res.json(requestsForPid);
    delete requests[pid];
  })
);

app.post(
  '/com.instana.plugin.nodejs/traces.:pid',
  checkExistenceOfKnownPid(function handleTraces(req, res) {
    const pid = req.params.pid;

    if (rejectTraces) {
      return res.sendStatus(400);
    }

    if (startUpDelay && Date.now() - startTime < startUpDelay) {
      logger.warn('Rejecting spans for pid %s due to artificial startup delay.', pid);
      return res.sendStatus(404);
    }

    if (!dropAllData) {
      receivedData.traces.push({
        pid: parseInt(pid, 10),
        time: Date.now(),
        data: req.body
      });
    }
    if (logTraces) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(req.body, null, 2));
      // eslint-disable-next-line no-console
      console.log('--\n');
    }
    res.send('OK');
  })
);

app.post(
  '/com.instana.plugin.nodejs/profiles.:pid',
  checkExistenceOfKnownPid(function handleProfiles(req, res) {
    const pid = req.params.pid;

    if (doesntHandleProfiles) {
      return res.sendStatus(404);
    }

    if (startUpDelay && Date.now() - startTime < startUpDelay) {
      logger.warn('Rejecting profiles for pid %s due to artificial startup delay.', pid);
      return res.sendStatus(404);
    }

    if (!dropAllData) {
      receivedData.profiles.push({
        pid: parseInt(pid, 10),
        time: Date.now(),
        data: req.body
      });
    }
    if (logProfiles) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(req.body, null, 2));
      // eslint-disable-next-line no-console
      console.log('--\n');
    }
    res.send('OK');
  })
);

app.post(
  '/com.instana.plugin.nodejs/response.:pid',
  checkExistenceOfKnownPid(function handleResponse(req, res) {
    if (!dropAllData) {
      receivedData.responses.push({
        pid: parseInt(req.params.pid, 10),
        time: Date.now(),
        messageId: req.query.messageId,
        data: req.body
      });
    }
    res.sendStatus(204);
  })
);

app.post('/tracermetrics', function handleTracermetrics(req, res) {
  if (!dropAllData) {
    receivedData.tracingMetrics.push(req.body);
  }
  if (!tracingMetrics) {
    res.sendStatus(404);
  } else {
    res.send('OK');
  }
});

app.post('/com.instana.plugin.generic.event', function postEvent(req, res) {
  if (!dropAllData) {
    receivedData.events.push(req.body);
  }
  res.send('OK');
});

app.post('/com.instana.plugin.generic.agent-monitoring-event', function postMonitoringEvent(req, res) {
  if (!dropAllData) {
    receivedData.monitoringEvents.push(req.body);
  }
  res.send('OK');
});

function checkExistenceOfKnownPid(fn) {
  return (req, res) => {
    const pid = req.params.pid;
    if (!discoveries[pid]) {
      logger.debug('Rejecting access for PID %s, not a known discovery', pid);
      return res.status(400).send(`Unknown discovery with pid: ${pid}`);
    }
    fn(req, res);
  };
}

app.delete('/', (req, res) => {
  receivedData = resetReceivedData();
  discoveries = {};
  requests = {};
  res.sendStatus(200);
});

app.get('/received/data', (req, res) => res.json(receivedData));

app.delete('/received/data', (req, res) => {
  receivedData = resetReceivedData();
  res.sendStatus(200);
});

app.get('/received/aggregated/metrics/:pid', (req, res) => res.json(receivedData.aggregatedMetrics[req.params.pid]));

app.get('/received/traces', (req, res) => res.json(receivedData.traces));

app.delete('/received/traces', (req, res) => {
  receivedData.traces = [];
  res.sendStatus(200);
});

app.get('/received/events', (req, res) => res.json(receivedData.events));

app.delete('/received/events', (req, res) => {
  receivedData.events = [];
  res.sendStatus(200);
});

app.get('/received/profiles', (req, res) => res.json(receivedData.profiles));

app.delete('/received/profiles', (req, res) => {
  receivedData.profiles = [];
  res.sendStatus(200);
});

app.get('/received/monitoringEvents', (req, res) => res.json(receivedData.monitoringEvents));

app.delete('/received/monitoringEvents', (req, res) => {
  receivedData.monitoringEvents = [];
  res.sendStatus(200);
});

app.get('/received/tracingMetrics', (req, res) => res.json(receivedData.tracingMetrics));

app.get('/discoveries', (req, res) => res.json(discoveries));

app.post('/reject-announce-attempts', (req, res) => {
  if (req.query && req.query.attempts) {
    rejectAnnounceAttempts = parseInt(req.query.attempts, 10);
  } else {
    rejectAnnounceAttempts = 1;
  }
  res.send('OK');
});

app.delete('/discoveries', (req, res) => {
  rejectAnnounceAttempts = 0;
  discoveries = {};
  res.send('OK');
});

app.post('/request/:pid', (req, res) => {
  requests[req.params.pid] = requests[req.params.pid] || [];
  requests[req.params.pid].push(req.body);
  res.send('OK');
});

app.listen(port, () => {
  logger.info('Agent stub listening on port: %s', port);
});

function aggregateMetrics(entityId, snapshotUpdate) {
  if (!receivedData.aggregatedMetrics[entityId]) {
    receivedData.aggregatedMetrics[entityId] = _.cloneDeep(snapshotUpdate);
  } else {
    deepMerge(receivedData.aggregatedMetrics[entityId], snapshotUpdate);
  }
}

function resetReceivedData() {
  rejectAnnounceAttempts = 0;
  return {
    metrics: [],
    aggregatedMetrics: {},
    traces: [],
    profiles: [],
    responses: [],
    events: [],
    monitoringEvents: [],
    tracingMetrics: []
  };
}
