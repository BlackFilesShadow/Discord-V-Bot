'use strict';

const path = require('node:path');

// Playwright launches from dashboard-ui (type=module). Bootstrap the root
// TypeScript harness explicitly as CommonJS so its production-module requires
// are independent of the UI package scope on Linux and Windows.
process.env.TS_NODE_PROJECT = path.resolve(__dirname, '..', 'tsconfig.test.json');
require('../node_modules/ts-node/register/transpile-only');
require('./e2e-dashboard-db-server.ts');
