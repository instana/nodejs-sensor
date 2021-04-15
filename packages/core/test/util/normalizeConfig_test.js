/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2019
 */

'use strict';

const expect = require('chai').expect;

const normalizeConfig = require('../../src/util/normalizeConfig');

describe('util.normalizeConfig', () => {
  beforeEach(resetEnv);
  afterEach(resetEnv);

  function resetEnv() {
    delete process.env.INSTANA_DISABLED_TRACERS;
    delete process.env.INSTANA_DISABLE_AUTO_INSTR;
    delete process.env.INSTANA_DISABLE_TRACING;
    delete process.env.INSTANA_TRACE_IMMEDIATELY;
    delete process.env.INSTANA_EXTRA_HTTP_HEADERS;
    delete process.env.INSTANA_FORCE_TRANSMISSION_STARTING_AT;
    delete process.env.INSTANA_EPHEMERAL_PROCESS;
    delete process.env.INSTANA_METRICS_TRANSMISSION_DELAY;
    delete process.env.INSTANA_SECRETS;
    delete process.env.INSTANA_SERVICE_NAME;
    delete process.env.INSTANA_STACK_TRACE_LENGTH;
    delete process.env.INSTANA_TRACING_TRANSMISSION_DELAY;
    delete process.env.INSTANA_SPANBATCHING_ENABLED;
    delete process.env.INSTANA_DISABLE_SPANBATCHING;
    delete process.env.INSTANA_DISABLE_W3C_TRACE_CORRELATION;
    delete process.env.INSTANA_COPY_PRECOMPILED_NATIVE_ADDONS;
    delete process.env.INSTANA_REBUILD_NATIVE_ADDONS_ON_DEMAND;
  }

  it('should apply all defaults', () => {
    checkDefaults(normalizeConfig());
    checkDefaults(normalizeConfig({}));
    checkDefaults(normalizeConfig({ tracing: {}, metrics: {} }));
    checkDefaults(normalizeConfig({ unknowConfigOption: 13 }));
  });

  it('should accept service name', () => {
    const config = normalizeConfig({ serviceName: 'custom-service-name' });
    expect(config.serviceName).to.equal('custom-service-name');
  });

  it('should accept service name from env var', () => {
    process.env.INSTANA_SERVICE_NAME = 'very-custom-service-name';
    const config = normalizeConfig();
    expect(config.serviceName).to.equal('very-custom-service-name');
  });

  it('should not accept non-string service name', () => {
    const config = normalizeConfig({ serviceName: 42 });
    expect(config.serviceName).to.not.exist;
  });

  it('should use custom metrics transmission settings from config', () => {
    const config = normalizeConfig({
      metrics: {
        transmissionDelay: 9753
      }
    });
    expect(config.metrics.transmissionDelay).to.equal(9753);
  });

  it('should use custom metrics transmission settings from env vars', () => {
    process.env.INSTANA_METRICS_TRANSMISSION_DELAY = '2500';
    const config = normalizeConfig();
    expect(config.metrics.transmissionDelay).to.equal(2500);
  });

  it('should use default metrics transmission settings when env vars are non-numerical', () => {
    process.env.INSTANA_METRICS_TRANSMISSION_DELAY = 'x2500';
    const config = normalizeConfig();
    expect(config.metrics.transmissionDelay).to.equal(1000);
  });

  it('should use custom config.metrics.timeBetweenHealthcheckCalls', () => {
    const config = normalizeConfig({
      metrics: {
        timeBetweenHealthcheckCalls: 9876
      }
    });
    expect(config.metrics.timeBetweenHealthcheckCalls).to.equal(9876);
    expect(config.timeBetweenHealthcheckCalls).to.not.exist;
  });

  it('should use legacy config.timeBetweenHealthcheckCalls', () => {
    const config = normalizeConfig({ timeBetweenHealthcheckCalls: 1234 });
    expect(config.metrics.timeBetweenHealthcheckCalls).to.equal(1234);
    expect(config.timeBetweenHealthcheckCalls).to.not.exist;
  });

  it('should disable tracing', () => {
    const config = normalizeConfig({ tracing: { enabled: false } });
    expect(config.tracing.enabled).to.be.false;
    expect(config.tracing.automaticTracingEnabled).to.be.false;
    expect(config.tracing.disableAutomaticTracing).to.not.exist;
  });

  it('should disable tracing via INSTANA_DISABLE_TRACING', () => {
    process.env.INSTANA_DISABLE_TRACING = true;
    const config = normalizeConfig();
    expect(config.tracing.enabled).to.be.false;
    expect(config.tracing.automaticTracingEnabled).to.be.false;
  });

  it('should disable automatic tracing', () => {
    const config = normalizeConfig({ tracing: { automaticTracingEnabled: false } });
    expect(config.tracing.enabled).to.be.true;
    expect(config.tracing.automaticTracingEnabled).to.be.false;
    expect(config.tracing.disableAutomaticTracing).to.not.exist;
  });

  it('should disable automatic tracing (legacy config)', () => {
    const config = normalizeConfig({ tracing: { disableAutomaticTracing: true } });
    expect(config.tracing.enabled).to.be.true;
    expect(config.tracing.automaticTracingEnabled).to.be.false;
    expect(config.tracing.disableAutomaticTracing).to.not.exist;
  });

  it('should disable automatic tracing via INSTANA_DISABLE_AUTO_INSTR', () => {
    process.env.INSTANA_DISABLE_AUTO_INSTR = 'true';
    const config = normalizeConfig();
    expect(config.tracing.enabled).to.be.true;
    expect(config.tracing.automaticTracingEnabled).to.be.false;
    expect(config.tracing.disableAutomaticTracing).to.not.exist;
  });

  it('should not enable automatic tracing when tracing is disabled in general', () => {
    const config = normalizeConfig({
      tracing: {
        enabled: false,
        automaticTracingEnabled: true
      }
    });
    expect(config.tracing.enabled).to.be.false;
    expect(config.tracing.automaticTracingEnabled).to.be.false;
    expect(config.tracing.disableAutomaticTracing).to.not.exist;
  });

  it('should enable immediate tracing activation', () => {
    const config = normalizeConfig({ tracing: { activateImmediately: true } });
    expect(config.tracing.activateImmediately).to.be.true;
  });

  it('should enable immediate tracing activation via INSTANA_TRACE_IMMEDIATELY', () => {
    process.env.INSTANA_TRACE_IMMEDIATELY = 'true';
    const config = normalizeConfig();
    expect(config.tracing.activateImmediately).to.be.true;
  });

  it('should not enable immediate tracing activation when tracing is disabled in general', () => {
    const config = normalizeConfig({
      tracing: {
        enabled: false,
        activateImmediately: true
      }
    });
    expect(config.tracing.enabled).to.be.false;
    expect(config.tracing.activateImmediately).to.be.false;
  });

  it('should use custom tracing transmission settings from config', () => {
    const config = normalizeConfig({
      tracing: {
        maxBufferedSpans: 13,
        forceTransmissionStartingAt: 2,
        transmissionDelay: 9753
      }
    });
    expect(config.tracing.maxBufferedSpans).to.equal(13);
    expect(config.tracing.forceTransmissionStartingAt).to.equal(2);
    expect(config.tracing.transmissionDelay).to.equal(9753);
  });

  it('should use custom tracing transmission settings from env vars', () => {
    process.env.INSTANA_FORCE_TRANSMISSION_STARTING_AT = '2468';
    process.env.INSTANA_TRACING_TRANSMISSION_DELAY = '2500';
    const config = normalizeConfig();
    expect(config.tracing.forceTransmissionStartingAt).to.equal(2468);
    expect(config.tracing.transmissionDelay).to.equal(2500);
  });

  it('should use default tracing transmission settings when env vars are non-numerical', () => {
    process.env.INSTANA_FORCE_TRANSMISSION_STARTING_AT = 'a2468';
    process.env.INSTANA_TRACING_TRANSMISSION_DELAY = 'x2500';
    const config = normalizeConfig();
    expect(config.tracing.forceTransmissionStartingAt).to.equal(500);
    expect(config.tracing.transmissionDelay).to.equal(1000);
  });

  it('should use extra http headers (and normalize to lower case)', () => {
    const config = normalizeConfig({
      tracing: {
        http: {
          extraHttpHeadersToCapture: ['yo', 'LO']
        }
      }
    });
    expect(config.tracing.http.extraHttpHeadersToCapture).to.deep.equal(['yo', 'lo']);
  });

  it('should reject non-array extra http headers configuration value', () => {
    const config = normalizeConfig({
      tracing: {
        http: {
          extraHttpHeadersToCapture: 'yolo'
        }
      }
    });
    expect(config.tracing.http.extraHttpHeadersToCapture).to.be.an('array');
    expect(config.tracing.http.extraHttpHeadersToCapture).to.be.empty;
  });

  it('should parse extra headers from env var', () => {
    process.env.INSTANA_EXTRA_HTTP_HEADERS = ' X-Header-1 ; X-hEADer-2 , X-Whatever ';
    const config = normalizeConfig();
    expect(config.tracing.http.extraHttpHeadersToCapture).to.deep.equal(['x-header-1', 'x-header-2', 'x-whatever']);
  });

  it('must use default extra headers (empty list) when INSTANA_EXTRA_HTTP_HEADERS is invalid', () => {
    process.env.INSTANA_EXTRA_HTTP_HEADERS = ' \n \t ';
    const config = normalizeConfig();
    expect(config.tracing.http.extraHttpHeadersToCapture).to.deep.equal([]);
  });

  it('should accept numerical custom stack trace length', () => {
    const config = normalizeConfig({ tracing: { stackTraceLength: 666 } });
    expect(config.tracing.stackTraceLength).to.equal(666);
  });

  it('should normalize numbers for custom stack trace length', () => {
    const config = normalizeConfig({ tracing: { stackTraceLength: -28.08 } });
    expect(config.tracing.stackTraceLength).to.be.a('number');
    expect(config.tracing.stackTraceLength).to.equal(28);
  });

  it('should accept number-like strings for custom stack trace length', () => {
    const config = normalizeConfig({ tracing: { stackTraceLength: '1302' } });
    expect(config.tracing.stackTraceLength).to.be.a('number');
    expect(config.tracing.stackTraceLength).to.equal(1302);
  });

  it('should normalize number-like strings for custom stack trace length', () => {
    const config = normalizeConfig({ tracing: { stackTraceLength: '-16.04' } });
    expect(config.tracing.stackTraceLength).to.be.a('number');
    expect(config.tracing.stackTraceLength).to.equal(16);
  });

  it('should reject non-numerical strings for custom stack trace length', () => {
    const config = normalizeConfig({ tracing: { stackTraceLength: 'three' } });
    expect(config.tracing.stackTraceLength).to.be.a('number');
    expect(config.tracing.stackTraceLength).to.equal(10);
  });

  it('should reject custom stack trace length which is neither a number nor a string', () => {
    const config = normalizeConfig({ tracing: { stackTraceLength: false } });
    expect(config.tracing.stackTraceLength).to.be.a('number');
    expect(config.tracing.stackTraceLength).to.equal(10);
  });

  it('should read stack trace length from INSTANA_STACK_TRACE_LENGTH', () => {
    process.env.INSTANA_STACK_TRACE_LENGTH = '3';
    const config = normalizeConfig();
    expect(config.tracing.stackTraceLength).to.equal(3);
  });

  it('should not disable individual tracers by default', () => {
    const config = normalizeConfig();
    expect(config.tracing.disabledTracers).to.deep.equal([]);
  });

  it('should disable individual tracers via config', () => {
    const config = normalizeConfig({
      tracing: {
        disabledTracers: ['graphQL', 'GRPC']
      }
    });
    // values will be normalized to lower case
    expect(config.tracing.disabledTracers).to.deep.equal(['graphql', 'grpc']);
  });

  it('should disable individual tracers via env var', () => {
    process.env.INSTANA_DISABLED_TRACERS = 'graphQL   , GRPC';
    const config = normalizeConfig();
    // values will be normalized to lower case
    expect(config.tracing.disabledTracers).to.deep.equal(['graphql', 'grpc']);
  });

  it('config should take precedence over env vars when disabling individual tracers', () => {
    process.env.INSTANA_DISABLED_TRACERS = 'foo, bar';
    const config = normalizeConfig({
      tracing: {
        disabledTracers: ['baz', 'fizz']
      }
    });
    // values will be normalized to lower case
    expect(config.tracing.disabledTracers).to.deep.equal(['baz', 'fizz']);
  });

  // delete this test when we switch to opt-out
  it('should enable span batching via config in transition phase', () => {
    const config = normalizeConfig({ tracing: { spanBatchingEnabled: true } });
    expect(config.tracing.spanBatchingEnabled).to.be.true;
  });

  // delete this test when we switch to opt-out
  it('should enable span batching via INSTANA_SPANBATCHING_ENABLED in transition phase', () => {
    process.env.INSTANA_SPANBATCHING_ENABLED = 'true';
    const config = normalizeConfig();
    expect(config.tracing.spanBatchingEnabled).to.be.true;
  });

  it('should ignore non-boolean span batching config value', () => {
    const config = normalizeConfig({ tracing: { spanBatchingEnabled: 73 } });
    // test needs to be updated once we switch to opt-out
    expect(config.tracing.spanBatchingEnabled).to.be.false;
  });

  it('should disable span batching', () => {
    // test only becomes relevant once we switch to opt-out
    const config = normalizeConfig({ tracing: { spanBatchingEnabled: false } });
    expect(config.tracing.spanBatchingEnabled).to.be.false;
  });

  it('should disable span batching via INSTANA_DISABLE_SPANBATCHING', () => {
    // test only becomes relevant once we switch to opt-out
    process.env.INSTANA_DISABLE_SPANBATCHING = 'true';
    const config = normalizeConfig();
    expect(config.tracing.spanBatchingEnabled).to.be.false;
  });

  it('should disable W3C trace correlation', () => {
    const config = normalizeConfig({ tracing: { disableW3cTraceCorrelation: true } });
    expect(config.tracing.disableW3cTraceCorrelation).to.be.true;
  });

  it('should disable W3C trace correlation via INSTANA_DISABLE_W3C_TRACE_CORRELATION', () => {
    process.env.INSTANA_DISABLE_W3C_TRACE_CORRELATION = 'false'; // any non-empty string will disable, even "false"!
    const config = normalizeConfig();
    expect(config.tracing.disableW3cTraceCorrelation).to.be.true;
  });

  it('should enable ephemeral process settings via config', () => {
    const config = normalizeConfig({ tracing: { ephemeralProcess: true } });
    expect(config.tracing.ephemeralProcess).to.be.true;
    expect(config.tracing.activateImmediately).to.be.true;
    expect(config.tracing.forceTransmissionStartingAt).to.equal(1);
    expect(config.tracing.maxKeepAliveUntilSpanBufferIsEmpty).to.equal(5000);
    expect(process.env.INSTANA_COPY_PRECOMPILED_NATIVE_ADDONS).to.equal('false');
    expect(process.env.INSTANA_REBUILD_NATIVE_ADDONS_ON_DEMAND).to.equal('false');
  });

  it('should enable ephemeral process settings via INSTANA_EPHEMERAL_PROCESS', () => {
    process.env.INSTANA_EPHEMERAL_PROCESS = 'true';
    const config = normalizeConfig();
    expect(config.tracing.ephemeralProcess).to.be.true;
    expect(config.tracing.activateImmediately).to.be.true;
    expect(config.tracing.forceTransmissionStartingAt).to.equal(1);
    expect(config.tracing.maxKeepAliveUntilSpanBufferIsEmpty).to.equal(5000);
    expect(process.env.INSTANA_COPY_PRECOMPILED_NATIVE_ADDONS).to.equal('false');
    expect(process.env.INSTANA_REBUILD_NATIVE_ADDONS_ON_DEMAND).to.equal('false');
  });

  it('should ignore non-boolean ephemeral process config value', () => {
    const config = normalizeConfig({ tracing: { ephemeralProcess: 73 } });
    expect(config.tracing.ephemeralProcess).to.be.false;
    expect(config.tracing.activateImmediately).to.be.false;
    expect(config.tracing.forceTransmissionStartingAt).to.equal(500);
    expect(config.tracing.maxKeepAliveUntilSpanBufferIsEmpty).to.equal(0);
    expect(process.env.INSTANA_COPY_PRECOMPILED_NATIVE_ADDONS).to.not.exist;
    expect(process.env.INSTANA_REBUILD_NATIVE_ADDONS_ON_DEMAND).to.not.exist;
  });

  it('should be able to override activateImmediately when ephemeral process is set', () => {
    const config = normalizeConfig({
      tracing: {
        ephemeralProcess: true,
        activateImmediately: false
      }
    });
    expect(config.tracing.ephemeralProcess).to.be.true;
    expect(config.tracing.activateImmediately).to.be.false;
    expect(config.tracing.forceTransmissionStartingAt).to.equal(1);
    expect(config.tracing.maxKeepAliveUntilSpanBufferIsEmpty).to.equal(5000);
  });

  it('should be able to override forceTransmissionStartingAt when ephemeral process is set', () => {
    const config = normalizeConfig({
      tracing: {
        ephemeralProcess: true,
        forceTransmissionStartingAt: 10
      }
    });
    expect(config.tracing.ephemeralProcess).to.be.true;
    expect(config.tracing.activateImmediately).to.be.true;
    expect(config.tracing.forceTransmissionStartingAt).to.equal(10);
    expect(config.tracing.maxKeepAliveUntilSpanBufferIsEmpty).to.equal(5000);
  });

  it('should be able to override maxKeepAliveUntilSpanBufferIsEmpty when ephemeral process is set', () => {
    const config = normalizeConfig({
      tracing: {
        ephemeralProcess: true,
        maxKeepAliveUntilSpanBufferIsEmpty: 3000
      }
    });
    expect(config.tracing.ephemeralProcess).to.be.true;
    expect(config.tracing.activateImmediately).to.be.true;
    expect(config.tracing.forceTransmissionStartingAt).to.equal(1);
    expect(config.tracing.maxKeepAliveUntilSpanBufferIsEmpty).to.equal(3000);
  });

  it('should be able to override INSTANA_TRACE_IMMEDIATELY when INSTANA_EPHEMERAL_PROCESS is set', () => {
    process.env.INSTANA_EPHEMERAL_PROCESS = 'true';
    process.env.INSTANA_TRACE_IMMEDIATELY = 'false';
    const config = normalizeConfig();
    expect(config.tracing.ephemeralProcess).to.be.true;
    expect(config.tracing.activateImmediately).to.be.false;
    expect(config.tracing.forceTransmissionStartingAt).to.equal(1);
    expect(config.tracing.maxKeepAliveUntilSpanBufferIsEmpty).to.equal(5000);
  });

  it('should be able to override INSTANA_FORCE_TRANSMISSION_STARTING_AT when INSTANA_EPHEMERAL_PROCESS is set', () => {
    process.env.INSTANA_EPHEMERAL_PROCESS = 'true';
    process.env.INSTANA_FORCE_TRANSMISSION_STARTING_AT = '10';
    const config = normalizeConfig();
    expect(config.tracing.ephemeralProcess).to.be.true;
    expect(config.tracing.activateImmediately).to.be.true;
    expect(config.tracing.forceTransmissionStartingAt).to.equal(10);
    expect(config.tracing.maxKeepAliveUntilSpanBufferIsEmpty).to.equal(5000);
  });

  it(
    'should be able to override INSTANA_MAX_KEEP_ALIVE_UNTIL_SPAN_BUFFER_IS_EMPTY when ' +
      'INSTANA_EPHEMERAL_PROCESS is set',
    () => {
      process.env.INSTANA_EPHEMERAL_PROCESS = 'true';
      process.env.INSTANA_MAX_KEEP_ALIVE_UNTIL_SPAN_BUFFER_IS_EMPTY = '7000';
      const config = normalizeConfig();
      expect(config.tracing.ephemeralProcess).to.be.true;
      expect(config.tracing.activateImmediately).to.be.true;
      expect(config.tracing.forceTransmissionStartingAt).to.equal(1);
      expect(config.tracing.maxKeepAliveUntilSpanBufferIsEmpty).to.equal(7000);
    }
  );

  it('should accept custom secrets config', () => {
    const config = normalizeConfig({
      secrets: {
        matcherMode: 'equals',
        keywords: ['custom-secret', 'sheesh']
      }
    });
    expect(config.secrets.matcherMode).to.equal('equals');
    expect(config.secrets.keywords).to.deep.equal(['custom-secret', 'sheesh']);
  });

  it("should set keywords to empty array for matcher mode 'none'", () => {
    const config = normalizeConfig({
      secrets: {
        matcherMode: 'none'
      }
    });
    expect(config.secrets.matcherMode).to.equal('none');
    expect(config.secrets.keywords).to.deep.equal([]);
  });

  it('should reject non-string matcher mode', () => {
    const config = normalizeConfig({ secrets: { matcherMode: 43 } });
    expect(config.secrets.matcherMode).to.equal('contains-ignore-case');
    expect(config.secrets.keywords).to.deep.equal(['key', 'pass', 'secret']);
  });

  it('should reject unknown matcher mode from config', () => {
    const config = normalizeConfig({ secrets: { matcherMode: 'whatever' } });
    expect(config.secrets.matcherMode).to.equal('contains-ignore-case');
    expect(config.secrets.keywords).to.deep.equal(['key', 'pass', 'secret']);
  });

  it('should reject non-array keywords', () => {
    const config = normalizeConfig({ secrets: { keywords: 'yes' } });
    expect(config.secrets.matcherMode).to.equal('contains-ignore-case');
    expect(config.secrets.keywords).to.deep.equal(['key', 'pass', 'secret']);
  });

  it('should parse secrets from env var', () => {
    process.env.INSTANA_SECRETS = ' eQuaLs-igNore-case  :  concealed  ,  hush  ';
    const config = normalizeConfig();
    expect(config.secrets.matcherMode).to.equal('equals-ignore-case');
    expect(config.secrets.keywords).to.deep.equal(['concealed', 'hush']);
  });

  it('must use default secrets when INSTANA_SECRETS is invalid', () => {
    process.env.INSTANA_SECRETS = 'whatever';
    const config = normalizeConfig();
    expect(config.secrets.matcherMode).to.equal('contains-ignore-case');
    expect(config.secrets.keywords).to.deep.equal(['key', 'pass', 'secret']);
  });

  it("must accept INSTANA_SECRETS without secrets list if matcher mode is 'none'", () => {
    process.env.INSTANA_SECRETS = 'NONE';
    const config = normalizeConfig();
    expect(config.secrets.matcherMode).to.equal('none');
    expect(config.secrets.keywords).to.deep.equal([]);
  });

  it('should reject unknown matcher mode from INSTANA_SECRETS', () => {
    process.env.INSTANA_SECRETS = 'unknown-matcher:nope,never';
    const config = normalizeConfig();
    expect(config.secrets.matcherMode).to.equal('contains-ignore-case');
    expect(config.secrets.keywords).to.deep.equal(['nope', 'never']);
  });

  function checkDefaults(config) {
    expect(config).to.be.an('object');
    expect(config.serviceName).to.not.exist;
    expect(config.metrics).to.be.an('object');
    expect(config.metrics.transmissionDelay).to.equal(1000);
    expect(config.metrics.timeBetweenHealthcheckCalls).to.equal(3000);
    expect(config.tracing).to.be.an('object');
    expect(config.tracing.enabled).to.be.true;
    expect(config.tracing.automaticTracingEnabled).to.be.true;
    expect(config.tracing.disableAutomaticTracing).to.not.exist;
    expect(config.tracing.activateImmediately).to.be.false;
    expect(config.tracing.transmissionDelay).to.equal(1000);
    expect(config.tracing.forceTransmissionStartingAt).to.equal(500);
    expect(config.tracing.maxBufferedSpans).to.equal(1000);
    expect(config.tracing.disabledTracers).to.deep.equal([]);
    expect(config.tracing.ephemeralProcess).to.be.false;
    expect(config.tracing.maxKeepAliveUntilSpanBufferIsEmpty).to.equal(0);
    expect(config.tracing.http).to.be.an('object');
    expect(config.tracing.http.extraHttpHeadersToCapture).to.be.empty;
    expect(config.tracing.http.extraHttpHeadersToCapture).to.be.an('array');
    expect(config.tracing.http.extraHttpHeadersToCapture).to.be.empty;
    expect(config.tracing.http.extraHttpHeadersToCapture).to.be.empty;
    expect(config.tracing.stackTraceLength).to.equal(10);
    expect(config.tracing.spanBatchingEnabled).to.be.false;
    expect(config.tracing.disableW3cTraceCorrelation).to.be.false;
    expect(config.secrets).to.be.an('object');
    expect(config.secrets.matcherMode).to.equal('contains-ignore-case');
    expect(config.secrets.keywords).to.deep.equal(['key', 'pass', 'secret']);
  }
});
