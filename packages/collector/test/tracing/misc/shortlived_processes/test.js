/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2021
 */

'use strict';

const expect = require('chai').expect;

const constants = require('@instana/core').tracing.constants;
const supportedVersion = require('@instana/core').tracing.supportedVersion;
const config = require('../../../../../core/test/config');
const { delay, expectAtLeastOneMatching, retry } = require('../../../../../core/test/test_util');
const { AgentStubControls } = require('../../../apps/agentStubControls');
const ProcessControls = require('../../../test_util/ProcessControls');

const mochaSuiteFn = supportedVersion(process.versions.node) ? describe : describe.skip;

mochaSuiteFn('tracing/short lived processes', function() {
  const retryTimeout = Math.max(config.getTestTimeout(), 5000);
  this.timeout(retryTimeout * 2);

  [true, false].forEach(tracingEnabled => {
    ['manual', 'autotrace'].forEach(tracingMode => {
      registerSuite(tracingMode, tracingEnabled);
    });
  });

  function registerSuite(tracingMode, tracingEnabled) {
    describe(`tracing mode: ${tracingMode} / tracing enabled: ${tracingEnabled}`, () => {
      const agentControls = new AgentStubControls();
      agentControls.registerTestHooks({
        startUpDelay: 1500
      });

      const env =
        tracingMode === 'manual'
          ? {
              MANUAL_TRACING: true
            }
          : undefined;

      const controls = new ProcessControls({
        dirname: __dirname,
        tracingEnabled,
        env,
        // deliberately not passing agentControls to the app because we do not want to wait for the agent to be started
        agentPort: 3210
      }).registerTestHooks();

      registerTest(controls, agentControls, tracingMode, tracingEnabled);
    });
  }

  function registerTest(controls, agentControls, tracingMode, tracingEnabled) {
    it(
      'must capture spans before connecting to the agent and wait until they have been sent to the agent ' +
        `(tracing: ${tracingMode}, enabled: ${tracingEnabled})`,
      () => {
        if (tracingMode === 'manual') {
          return verify(agentControls, controls, tracingMode, tracingEnabled);
        } else if (tracingMode === 'autotrace') {
          return controls
            .sendRequest({
              method: 'POST',
              path: '/do-stuff'
            })
            .then(() => verify(agentControls, controls, tracingMode, tracingEnabled));
        } else {
          throw new Error(`Unknown tracing mode ${tracingMode}.`);
        }
      }
    );
  }

  function verify(agentControls, controls, tracingMode, tracingEnabled) {
    if (tracingEnabled) {
      return verifySpans(agentControls, controls, tracingMode);
    } else {
      return verifyNoSpans(agentControls);
    }
  }

  function verifySpans(agentControls, controls, tracingMode) {
    if (tracingMode === 'manual') {
      return verifyManualSpans(agentControls, controls);
    } else if (tracingMode === 'autotrace') {
      return verifyAutoTraceSpans(agentControls, controls);
    } else {
      throw new Error(`Unknown tracing mode ${tracingMode}.`);
    }
  }

  function verifyManualSpans(agentControls, controls) {
    return retry(
      () =>
        agentControls.getSpans().then(spans => {
          const sdkEntry = expectAtLeastOneMatching(spans, [
            span => expect(span.n).to.equal('sdk'),
            span => expect(span.k).to.equal(constants.ENTRY),
            span => expect(span.p).to.not.exist,
            span => expect(span.data.sdk.type).to.equal('entry'),
            span => expect(span.data.sdk.name).to.equal('test-entry'),
            span => expect(span.f.e).to.equal(String(controls.getPid()))
          ]);
          expectAtLeastOneMatching(spans, [
            span => expect(span.n).to.equal('sdk'),
            span => expect(span.k).to.equal(constants.EXIT),
            span => expect(span.p).to.equal(sdkEntry.s),
            span => expect(span.data.sdk.type).to.equal('exit'),
            span => expect(span.data.sdk.name).to.equal('test-exit'),
            span => expect(span.f.e).to.equal(String(controls.getPid()))
          ]);
        }),
      retryTimeout
    );
  }

  function verifyAutoTraceSpans(agentControls, controls) {
    return retry(
      () =>
        agentControls.getSpans().then(spans => {
          const httpEntry = expectAtLeastOneMatching(spans, [
            span => expect(span.n).to.equal('node.http.server'),
            span => expect(span.k).to.equal(constants.ENTRY),
            span => expect(span.p).to.not.exist,
            span => expect(span.data.http.method).to.equal('POST'),
            span => expect(span.data.http.url).to.equal('/do-stuff'),
            span => expect(span.f.e).to.equal(String(controls.getPid()))
          ]);
          expectAtLeastOneMatching(spans, [
            span => expect(span.n).to.equal('node.http.client'),
            span => expect(span.k).to.equal(constants.EXIT),
            span => expect(span.t).to.equal(httpEntry.t),
            span => expect(span.p).to.equal(httpEntry.s),
            span => expect(span.f.e).to.equal(String(controls.getPid()))
          ]);
        }),
      retryTimeout
    );
  }

  async function verifyNoSpans(agentControls) {
    await delay(3000);
    const spans = await agentControls.getSpans();
    expect(spans.length).to.equal(0);
  }
});
