/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2016
 */

'use strict';

const spawn = require('child_process').spawn;
const request = require('request-promise');
const path = require('path');
const _ = require('lodash');

const { retry } = require('../../../core/test/test_util');
const config = require('../../../core/test/config');

const DEFAULT_AGENT_PORT = 3210;

class AgentStubControls {
  constructor(agentPort) {
    this.agentPort = agentPort || DEFAULT_AGENT_PORT;
  }

  registerHooksForSuite(opts = {}) {
    before(() => this.startAgent(opts));
    after(() => this.stopAgent(opts));

    beforeEach(() => this.clearReceivedData());
    afterEach(() => this.clearReceivedData());

    return this;
  }

  registerTestHooks(opts = {}) {
    beforeEach(() => this.startAgent(opts));
    afterEach(() => this.stopAgent(opts));

    return this;
  }

  async startAgent(opts = {}) {
    const env = Object.create(process.env);
    env.AGENT_PORT = this.agentPort;
    env.EXTRA_HEADERS = (opts.extraHeaders || []).join(',');
    env.SECRETS_MATCHER = opts.secretsMatcher || 'contains-ignore-case';
    env.SECRETS_LIST = (opts.secretsList || []).join(',');
    env.SECRETS_LIST = (opts.secretsList || []).join(',');
    if (opts.rejectTraces) {
      env.REJECT_TRACES = 'true';
    }
    if (opts.doesntHandleProfiles) {
      env.DOESNT_HANDLE_PROFILES = 'true';
    }
    if (typeof opts.tracingMetrics === 'boolean') {
      env.TRACING_METRICS = opts.tracingMetrics.toString();
    }
    if (opts.enableSpanBatching) {
      env.ENABLE_SPANBATCHING = 'true';
    }
    if (opts.startUpDelay) {
      env.STARTUP_DELAY = opts.startUpDelay;
    }

    this.agentStub = spawn('node', [path.join(__dirname, 'agentStub.js')], {
      stdio: config.getAppStdio(),
      env
    });

    await this.waitUntilAgentHasStarted();
  }

  stopAgent() {
    this.agentStub.kill();
  }

  async waitUntilAgentHasStarted() {
    await retry(() =>
      request({
        method: 'GET',
        url: `http://127.0.0.1:${this.agentPort}`
      })
    );
  }

  async waitUntilAppIsCompletelyInitialized(pid) {
    await retry(() =>
      this.getReceivedData().then(data => {
        for (let i = 0, len = data.metrics.length; i < len; i++) {
          const d = data.metrics[i];
          if (d.pid === pid) {
            return true;
          }
        }

        throw new Error(`PID ${pid} never sent any data to the agent.`);
      })
    );
  }

  getDiscoveries() {
    return request({
      method: 'GET',
      url: `http://127.0.0.1:${this.agentPort}/discoveries`,
      json: true
    });
  }

  rejectAnnounceAttempts(rejectedAttempts = 1) {
    return request({
      method: 'POST',
      url: `http://127.0.0.1:${this.agentPort}/reject-announce-attempts?attempts=${rejectedAttempts}`
    });
  }

  deleteDiscoveries() {
    return request({
      method: 'DELETE',
      url: `http://127.0.0.1:${this.agentPort}/discoveries`,
      json: true
    });
  }

  getReceivedData() {
    return request({
      method: 'GET',
      url: `http://127.0.0.1:${this.agentPort}/received/data`,
      json: true
    });
  }

  getAggregatedMetrics(pid) {
    return request({
      method: 'GET',
      url: `http://127.0.0.1:${this.agentPort}/received/aggregated/metrics/${pid}`,
      json: true
    });
  }

  getEvents() {
    return request({
      method: 'GET',
      url: `http://127.0.0.1:${this.agentPort}/received/events`,
      json: true
    });
  }

  getMonitoringEvents() {
    return request({
      method: 'GET',
      url: `http://127.0.0.1:${this.agentPort}/received/monitoringEvents`,
      json: true
    });
  }

  clearReceivedMonitoringEvents() {
    return request({
      method: 'DELETE',
      url: `http://127.0.0.1:${this.agentPort}/received/monitoringEvents`
    });
  }

  reset() {
    return request({
      method: 'DELETE',
      url: `http://127.0.0.1:${this.agentPort}/`,
      json: true
    });
  }

  clearReceivedData() {
    return request({
      method: 'DELETE',
      url: `http://127.0.0.1:${this.agentPort}/received/data`
    });
  }

  clearReceivedTraceData() {
    return request({
      method: 'DELETE',
      url: `http://127.0.0.1:${this.agentPort}/received/traces`
    });
  }

  clearReceivedProfilingData() {
    return request({
      method: 'DELETE',
      url: `http://127.0.0.1:${this.agentPort}/received/profiles`
    });
  }

  clearReceivedEvents() {
    return request({
      method: 'DELETE',
      url: `http://127.0.0.1:${this.agentPort}/received/events`
    });
  }

  async getSpans() {
    const data = await this.getReceivedData();
    return data.traces.reduce((result, traceMessage) => result.concat(traceMessage.data), []);
  }

  async getProfiles() {
    const data = await this.getReceivedData();
    return data.profiles.reduce((result, profile) => result.concat(profile.data), []);
  }

  async getResponses() {
    const data = await this.getReceivedData();
    return data.responses;
  }

  getTracingMetrics() {
    return request({
      method: 'GET',
      url: `http://127.0.0.1:${this.agentPort}/received/tracingMetrics`,
      json: true
    });
  }

  async waitUntilAppIsCompletelyInitialized(originalPid) {
    let pid;
    if (typeof originalPid === 'string') {
      pid = parseInt(originalPid, 10);
      if (isNaN(pid)) {
        throw new Error(`PID has type string and cannot be parsed to a number: ${originalPid}`);
      }
    } else if (typeof originalPid === 'number') {
      pid = originalPid;
    } else {
      throw new Error(`PID ${originalPid} has invalid type ${typeof originalPid}.`);
    }

    await retry(() =>
      this.getReceivedData().then(data => {
        for (let i = 0, len = data.metrics.length; i < len; i++) {
          const d = data.metrics[i];
          if (d.pid === pid) {
            return true;
          }
        }

        throw new Error(`PID ${pid} never sent any data to the agent.`);
      })
    );
  }

  simulateDiscovery(pid) {
    return request({
      method: 'PUT',
      url: `http://127.0.0.1:${this.agentPort}/com.instana.plugin.nodejs.discovery`,
      json: true,
      body: {
        pid
      }
    });
  }

  addEntityData(pid, data) {
    return request({
      method: 'POST',
      url: `http://127.0.0.1:${this.agentPort}/com.instana.plugin.nodejs.${pid}`,
      json: true,
      body: data
    });
  }

  addRequestForPid(pid, r) {
    return request({
      method: 'POST',
      url: `http://127.0.0.1:${this.agentPort}/request/${pid}`,
      json: true,
      body: r
    });
  }

  async getLastMetricValue(pid, _path) {
    const data = await this.getReceivedData();
    return findLastMetricValueInResponse(pid, data, _path);
  }

  async getAllMetrics(pid) {
    const data = await this.getReceivedData();
    return filterByPid(pid, data);
  }
}

const legacySingletonInstance = new AgentStubControls();

module.exports = exports = {
  get agentPort() {
    return legacySingletonInstance.agentPort;
  }
};

exports.AgentStubControls = AgentStubControls;

// In a previous life, agentStubControls was a singleton module which started an agent before each individual test and
// stopped it afterwards. This became prohibitive in terms of test suite duration. The following exports are in place
// for legacy tests that still use this facility and have not been refactored to create an instance of AgentStubControls
// for themselves.
exports.registerTestHooks = opts => legacySingletonInstance.registerTestHooks(opts);
exports.startAgent = opts => legacySingletonInstance.startAgent(opts);
exports.stopAgent = () => legacySingletonInstance.stopAgent();
exports.waitUntilAgentHasStarted = () => legacySingletonInstance.waitUntilAgentHasStarted();
exports.waitUntilAppIsCompletelyInitialized = pid => legacySingletonInstance.waitUntilAppIsCompletelyInitialized(pid);
exports.getDiscoveries = () => legacySingletonInstance.getDiscoveries();
exports.deleteDiscoveries = () => legacySingletonInstance.deleteDiscoveries();
exports.getReceivedData = () => legacySingletonInstance.getReceivedData();
exports.getAggregatedMetrics = pid => legacySingletonInstance.getAggregatedMetrics(pid);
exports.getEvents = () => legacySingletonInstance.getEvents();
exports.getMonitoringEvents = () => legacySingletonInstance.getMonitoringEvents();
exports.clearReceivedData = () => legacySingletonInstance.clearReceivedData();
exports.clearReceivedTraceData = () => legacySingletonInstance.clearReceivedTraceData();
exports.clearReceivedEvents = () => legacySingletonInstance.clearReceivedEvents();
exports.clearReceivedProfilingData = () => legacySingletonInstance.clearReceivedProfilingData();
exports.clearReceivedMonitoringEvents = () => legacySingletonInstance.clearReceivedMonitoringEvents();
exports.reset = () => legacySingletonInstance.reset();
exports.getSpans = () => legacySingletonInstance.getSpans();
exports.getProfiles = () => legacySingletonInstance.getProfiles();
exports.getResponses = () => legacySingletonInstance.getResponses();
exports.getTracingMetrics = () => legacySingletonInstance.getTracingMetrics();
exports.waitUntilAppIsCompletelyInitialized = pid => legacySingletonInstance.waitUntilAppIsCompletelyInitialized(pid);
exports.simulateDiscovery = pid => legacySingletonInstance.simulateDiscovery(pid);
exports.addEntityData = (pid, data) => legacySingletonInstance.addEntityData(pid, data);
exports.addRequestForPid = (pid, r) => legacySingletonInstance.addRequestForPid(pid, r);
exports.getLastMetricValue = (pid, _path) => legacySingletonInstance.getLastMetricValue(pid, _path);
exports.getAllMetrics = pid => legacySingletonInstance.getAllMetrics(pid);

function findLastMetricValueInResponse(pid, data, _path) {
  for (let i = data.metrics.length - 1; i >= 0; i--) {
    const metricsMessage = data.metrics[i];
    if (metricsMessage.pid !== pid) {
      // eslint-disable-next-line no-continue
      continue;
    }

    const value = _.get(metricsMessage.data, _path, undefined);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function filterByPid(pid, data) {
  return data.metrics.filter(metricsMessage => metricsMessage.pid === pid);
}
