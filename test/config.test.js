'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, DEFAULT_FRAME_ANCESTORS } = require('../src/config');

test('defaults', () => {
  const c = loadConfig({});
  assert.equal(c.port, 8080);
  assert.equal(c.dataDir, '/data');
  assert.equal(c.adminKey, '');
  assert.deepEqual(c.frameAncestors, DEFAULT_FRAME_ANCESTORS);
});

test('default frame ancestors cover the documented Teams origins', () => {
  for (const origin of [
    'https://teams.microsoft.com', 'https://*.teams.microsoft.com', 'https://*.cloud.microsoft',
    'https://*.microsoft365.com', 'https://*.office.com', 'https://outlook.office365.com',
  ]) {
    assert.ok(DEFAULT_FRAME_ANCESTORS.includes(origin), origin);
  }
});

test('reads the environment', () => {
  const c = loadConfig({
    PORT: '3000', DATA_DIR: './data', ADMIN_KEY: 'k', FRAME_ANCESTORS: 'https://a.example  https://b.example',
  });
  assert.equal(c.port, 3000);
  assert.equal(c.dataDir, './data');
  assert.equal(c.adminKey, 'k');
  assert.deepEqual(c.frameAncestors, ['https://a.example', 'https://b.example']);
});

test('rejects an invalid port', () => {
  for (const PORT of ['abc', '0', '70000', '80.5']) assert.throws(() => loadConfig({ PORT }), /PORT/);
});

test('rejects frame ancestors that could break out of the header', () => {
  assert.throws(() => loadConfig({ FRAME_ANCESTORS: "https://a.example; script-src *" }), /FRAME_ANCESTORS/);
  assert.throws(() => loadConfig({ FRAME_ANCESTORS: 'https://a.example\nX-Evil: 1' }), /FRAME_ANCESTORS/);
});
