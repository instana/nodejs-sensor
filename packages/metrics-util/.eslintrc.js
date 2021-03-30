/*
 * (c) Copyright IBM Corp. 2021
 * (c) Copyright Instana Inc. and contributors 2020
 */

module.exports = {
  extends: '../../.eslintrc.js',

  parserOptions: {
    ecmaVersion: 2018
  },

  rules: {
    'class-methods-use-this': 'off',
    'max-classes-per-file': 'off'
  }
};
