'use strict';
const js = require('@eslint/js');
const globals = require('globals');

const tampermonkey = {
  GM_xmlhttpRequest: 'readonly', GM_getValue: 'readonly', GM_setValue: 'readonly', GM_addValueChangeListener: 'readonly',
  GM_openInTab: 'readonly', GM_info: 'readonly', unsafeWindow: 'readonly',
  io: 'readonly', // socket.io client from @require
};

module.exports = [
  { ignores: ['node_modules/', 'test/e2e/shots/', 'design/'] },
  js.configs.recommended,
  {
    files: ['ag-trade-widget.user.js', 'ag-intel.user.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: { ...globals.browser, ...tampermonkey, module: 'readonly' } },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-cond-assign': ['error', 'except-parens'],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-implicit-globals': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    files: ['test/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }], 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
];
