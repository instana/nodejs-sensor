'use strict';

var expect = require('chai').expect;

var supportedVersion = require('../../../src/tracing/index').supportedVersion;
var config = require('../../config');
var utils = require('../../utils');

describe('tracing/mssql', function() {
  if (!supportedVersion(process.versions.node)) {
    return;
  }

  this.timeout(config.getTestTimeout());
  var agentControls = require('../../apps/agentStubControls');
  agentControls.registerTestHooks();
  var AppControls = require('./controls');
  var appControls = new AppControls({
    agentControls: agentControls
  });
  appControls.registerTestHooks();

  it('must trace dummy select', function() {
    return appControls.sendRequest({
      method: 'GET',
      path: '/select-getdate'
    })
    .then(function(response) {
      expect(response.length).to.equal(1);

      return utils.retry(function() {
        return agentControls.getSpans()
        .then(function(spans) {
          var httpEntrySpan = utils.expectOneMatching(spans, function(span) {
            expect(span.n).to.equal('node.http.server');
            expect(span.data.http.method).to.equal('GET');
            expect(span.data.http.url).to.equal('/select-getdate');
          });

          utils.expectOneMatching(spans, function(span) {
            checkMssqlSpan(span, httpEntrySpan);
            expect(span.data.mssql.stmt).to.equal('SELECT GETDATE()');
          });
        });
      });
    });
  });


  it('must trace insert and select', function() {
    return appControls.sendRequest({
      method: 'POST',
      path: '/insert'
    })
    .then(function() {
      return appControls.sendRequest({
        method: 'POST',
        path: '/insert-params'
      });
    })
    .then(function() {
      return appControls.sendRequest({
        method: 'GET',
        path: '/select'
      });
    })
    .then(function(response) {
      expect(response.length).to.equal(2);
      expect(response[0].name).to.equal('gaius');
      expect(response[0].email).to.equal('gaius@julius.com');
      expect(response[1].name).to.equal('augustus');
      expect(response[1].email).to.equal('augustus@julius.com');
      return utils.retry(function() {
        return agentControls.getSpans()
        .then(function(spans) {
          var firstWriteEntry = utils.expectOneMatching(spans, function(span) {
            expect(span.n).to.equal('node.http.server');
            expect(span.data.http.method).to.equal('POST');
            expect(span.data.http.url).to.equal('/insert');
          });
          var secondWriteEntry = utils.expectOneMatching(spans, function(span) {
            expect(span.n).to.equal('node.http.server');
            expect(span.data.http.method).to.equal('POST');
            expect(span.data.http.url).to.equal('/insert-params');
          });
          var readEntry = utils.expectOneMatching(spans, function(span) {
            expect(span.n).to.equal('node.http.server');
            expect(span.data.http.method).to.equal('GET');
            expect(span.data.http.url).to.equal('/select');
          });

          utils.expectOneMatching(spans, function(span) {
            expect(span.data.mssql.stmt).to.equal(
              'INSERT INTO UserTable (name, email) VALUES (N\'gaius\', N\'gaius@julius.com\')'
            );
            checkMssqlSpan(span, firstWriteEntry);
          });
          utils.expectOneMatching(spans, function(span) {
            expect(span.data.mssql.stmt).to.equal('INSERT INTO UserTable (name, email) VALUES (@username, @email)');
            checkMssqlSpan(span, secondWriteEntry);
          });
          utils.expectOneMatching(spans, function(span) {
            expect(span.data.mssql.stmt).to.equal('SELECT name, email FROM UserTable');
            checkMssqlSpan(span, readEntry);
          });
        });
      });
    });
  });

  function checkMssqlSpan(span, parent) {
    expect(span.t).to.equal(parent.t);
    expect(span.p).to.equal(parent.s);
    expect(span.f.e).to.equal(String(appControls.getPid()));
    expect(span.n).to.equal('mssql');
    expect(span.async).to.equal(false);
    expect(span.error).to.equal(false);
    expect(span.data.mssql.host).to.equal('127.0.0.1');
    expect(span.data.mssql.port).to.equal(1433);
    expect(span.data.mssql.user).to.equal('sa');
    expect(span.data.mssql.db).to.equal('nodejssensor');
  }
});
