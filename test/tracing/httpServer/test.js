'use strict';

var expect = require('chai').expect;

var supportedVersion = require('../../../src/tracing/index').supportedVersion;
var config = require('../../config');
var utils = require('../../utils');

describe('tracing/httpServer', function() {
  if (!supportedVersion(process.versions.node)) {
    return;
  }

  // controls require features that aren't available in early Node.js versions
  var agentControls = require('../../apps/agentStubControls');
  var Controls = require('./controls');

  this.timeout(config.getTestTimeout());

  agentControls.registerTestHooks({
    extraHeaders: ['UsEr-AgEnt']
  });

  var controls = new Controls({
    agentControls: agentControls
  });
  controls.registerTestHooks();

  it('must report additional headers when requested', function() {
    var userAgent = 'medivhTheTeleporter';
    return controls.sendRequest({
      method: 'GET',
      path: '/',
      headers: {
        'User-Agent': userAgent
      }
    })
      .then(function() {
        return utils.retry(function() {
          return agentControls.getSpans()
          .then(function(spans) {
            utils.expectOneMatching(spans, function(span) {
              expect(span.data.http.header['user-agent']).to.equal(userAgent);
            });
          });
        });
      });
  });

  describe('express.js path templates', function() {
    check('/blub', '/blub');
    check('/sub/bar/42', '/sub/bar/:id');
    check('/sub/sub/bar/42', '/sub/sub/bar/:id');

    function check(actualPath, expectedTemplate) {
      it('must report express path templates for actual path: ' + actualPath, function() {
        return controls.sendRequest({
          method: 'GET',
          path: actualPath
        })
          .then(function() {
            return utils.retry(function() {
              return agentControls.getSpans()
              .then(function(spans) {
                utils.expectOneMatching(spans, function(span) {
                  expect(span.data.http.pathTpl).to.equal(expectedTemplate);
                });
              });
            });
          });
      });
    }
  });
});
