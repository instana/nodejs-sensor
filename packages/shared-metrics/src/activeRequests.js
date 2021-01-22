/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. 2016
 */

'use strict';

exports.payloadPrefix = 'activeRequests';

Object.defineProperty(exports, 'currentPayload', {
  get: function() {
    return process._getActiveRequests().length;
  }
});
