/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2018
 */

'use strict';

const _ = require('lodash');
const fork = require('child_process').fork;
const fs = require('fs');
const path = require('path');
const request = require('request-promise');

const config = require('../../../core/test/config');
const http2Promise = require('./http2Promise');
const testUtils = require('../../../core/test/test_util');
const globalAgent = require('../globalAgent');

const sslDir = path.join(__dirname, '..', 'apps', 'ssl');
const cert = fs.readFileSync(path.join(sslDir, 'cert'));

class ProcessControls {
  /**
   * Shorthand for setUpSuiteHooks and setUpTestCaseCleanUpHooks.
   */
  static setUpHooks(...allControls) {
    ProcessControls.setUpHooksWithRetryTime(null, ...allControls);
  }

  /**
   * Shorthand for setUpSuiteHooks and setUpTestCaseCleanUpHooks.
   */
  static setUpHooksWithRetryTime(retryTime, ...allControls) {
    ProcessControls.setUpSuiteHooksWithRetryTime(retryTime, ...allControls);
    ProcessControls.setUpTestCaseCleanUpHooks(...allControls);
  }

  /**
   * Starts the corresponding child process for all given controls before starting the suite and stops them after the
   * suite has finished.
   */
  static setUpSuiteHooks(...allControls) {
    ProcessControls.setUpSuiteHooksWithRetryTime(null, ...allControls);
  }

  /**
   * Starts the corresponding child process for all given controls before starting the suite and stops them after the
   * suite has finished.
   */
  static setUpSuiteHooksWithRetryTime(retryTime, ...allControls) {
    before(() => {
      return Promise.all(allControls.map(control => control.startAndWaitForAgentConnection(retryTime)));
    });
    after(() => {
      return Promise.all(allControls.map(control => control.stop()));
    });
  }

  /**
   * Cleans up per test-case data (IPC messages received from the child process) before and after each test case.
   */
  static setUpTestCaseCleanUpHooks(...allControls) {
    beforeEach(() => {
      return Promise.all(allControls.map(control => control.clearIpcMessages()));
    });
    afterEach(() => {
      return Promise.all(allControls.map(control => control.clearIpcMessages()));
    });
  }

  /**
   * @param opts {{
   * appPath: string,
   *   cwd: string,
   *   port: number,
   *   dirname: string,
   *   dontKillInAfterHook: boolean,
   *   http2: boolean,
   *   args: [],
   *   minimalDelay: number,
   *   usePreInit: boolean,
   *   useGlobalAgent: boolean,
   *   tracingEnabled: boolean,
   *   agentControls: any,
   *   env: {
   *     USE_HTTPS: string | boolean,
   *     [key: string]: any
   *   },
   * }} The available options
   */
  constructor(opts = {}) {
    if (!opts.appPath && !opts.dirname) {
      throw new Error('Missing mandatory config option, either appPath or dirname needs to be provided.');
    }
    if (opts.appPath && opts.dirname) {
      throw new Error('Invalid config, appPath and dirname are mutually exclusive.');
    }
    if (!opts.appPath && opts.dirname) {
      opts.appPath = path.join(opts.dirname, 'app');
    }

    // absolute path to .js file that should be executed
    this.appPath = opts.appPath;
    // optional working directory for the child process
    this.cwd = opts.cwd;
    // for scenarios where the app under tests terminates on its own
    this.dontKillInAfterHook = opts.dontKillInAfterHook;
    // arguments for the app under test
    this.args = opts.args;
    // server http2
    this.http2 = opts.http2;
    // whether or not to use TLS
    this.useHttps = opts.env && !!opts.env.USE_HTTPS;
    // http/https/http2 port
    this.port = opts.port || process.env.APP_PORT || 3215;
    this.baseUrl = `${this.useHttps || this.http2 ? 'https' : 'http'}://localhost:${this.port}`;
    this.tracingEnabled = opts.tracingEnabled !== false;
    this.usePreInit = opts.usePreInit === true;

    // Signals that this process intends to connect to the test suite's global agent stub on port 3211. Setting this to
    // true will result in a before/beforeEach call which ensures that the collector is successfully connected to that
    // agent.
    this.useGlobalAgent = opts.useGlobalAgent;

    // As an alternative to connecting to the global agent, process control instances can use an individual instance of
    // AgentStubControls (and consequently their own agent stub process). Passing an agent control instance will result
    // in a before/beforeEach call which ensures that the collector is successfully connected to that agent.
    this.useGlobalAgent = opts.useGlobalAgent;
    this.agentControls = opts.agentControls;
    if (!this.agentControls && this.useGlobalAgent) {
      this.agentControls = globalAgent.instance;
    }
    const agentPort = opts.agentPort || (this.agentControls ? this.agentControls.agentPort : undefined);

    this.env = _.assign(
      {},
      process.env,
      {
        APP_PORT: this.port,
        INSTANA_AGENT_PORT: agentPort,
        INSTANA_LOG_LEVEL: 'warn',
        INSTANA_DISABLE_TRACING: !this.tracingEnabled,
        INSTANA_FORCE_TRANSMISSION_STARTING_AT: '1',
        INSTANA_DEV_MIN_DELAY_BEFORE_SENDING_SPANS: opts.minimalDelay != null ? opts.minimalDelay : 0
      },
      opts.env
    );
    if (this.usePreInit) {
      this.env.INSTANA_EARLY_INSTRUMENTATION = 'true';
    }
    this.receivedIpcMessages = [];
  }

  /**
   * The _legacy_ convenience method used by tests that start and stop the app under test before/after each test case.
   * If possible, this should be avoided in new tests. Instead, use the static methods of this class named setUpHooks
   * and its variants to start the app under test once for a whole suite. This is crucial to keep the duration of the
   * whole test suite on CI under control.
   */
  registerTestHooks(retryTime) {
    if (this.agentControls) {
      beforeEach(() => this.startAndWaitForAgentConnection(retryTime));
    } else {
      beforeEach(() => this.start(retryTime));
    }

    afterEach(() => this.stop());

    return this;
  }

  async start(retryTime) {
    const that = this;
    this.receivedIpcMessages = [];

    const forkConfig = {
      stdio: config.getAppStdio(),
      env: this.env
    };
    if (this.cwd) {
      forkConfig.cwd = this.cwd;
    }

    this.process = this.args ? fork(this.appPath, this.args, forkConfig) : fork(this.appPath, forkConfig);

    this.process.on('message', message => {
      that.receivedIpcMessages.push(message);
    });

    await this.waitUntilServerIsUp(retryTime);
  }

  async stop() {
    await this.kill();
  }

  async waitUntilServerIsUp(retryTime) {
    await testUtils.retry(
      () =>
        this.sendRequest({
          method: 'GET',
          suppressTracing: true
        }),
      retryTime
    );
  }

  async startAndWaitForAgentConnection(retryTime) {
    await this.start(retryTime);
    await this.agentControls.waitUntilAppIsCompletelyInitialized(this.getPid());
  }

  async waitForAgentConnection() {
    await this.agentControls.waitUntilAppIsCompletelyInitialized(this.getPid());
  }

  clearIpcMessages() {
    this.receivedIpcMessages = [];
  }

  getPid() {
    if (!this.process) {
      return 'no process, no PID';
    }
    return this.process.pid;
  }

  /**
   * @param opts {{
   *   suppressTracing: boolean,
   *   url: string,
   *   json: boolean,
   *   ca: Buffer,
   *   headers: {
   *     'X-INSTANA-L': '0' | '1',
   *     [key:string]: any
   *   }
   * }} The request options
   */
  sendRequest(opts) {
    const requestOptions = Object.assign({}, opts);
    requestOptions.baseUrl = this.baseUrl;
    if (this.http2) {
      return http2Promise.request(requestOptions);
    } else {
      if (opts.suppressTracing === true) {
        opts.headers = opts.headers || {};
        opts.headers['X-INSTANA-L'] = '0';
      }

      opts.url = this.baseUrl + (opts.path || '');
      opts.json = true;
      opts.ca = cert;

      return request(opts);
    }
  }

  sendViaIpc(message) {
    this.process.send(message);
  }

  getIpcMessages() {
    return this.receivedIpcMessages;
  }

  kill() {
    if (!this.process) {
      return Promise.resolve();
    }
    if (this.process.killed || this.dontKillInAfterHook) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.process.once('exit', resolve);
      this.process.kill();
    });
  }
}

module.exports = ProcessControls;
