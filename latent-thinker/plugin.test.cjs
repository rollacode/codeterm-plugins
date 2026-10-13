const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { join } = require('node:path');
const manifest = JSON.parse(readFileSync(join(__dirname, 'plugin.json'), 'utf8'));
function fixture() {
  const calls = [];
  const sandbox = { module: { exports: {} }, host: {
    log() {},
    fetch(raw) { calls.push(JSON.parse(raw)); return JSON.stringify({body: JSON.stringify({ok: true})}); },
  } };
  vm.runInNewContext(readFileSync(join(__dirname, 'plugin.js'), 'utf8'), sandbox);
  return { plugin: sandbox.module.exports.default, calls };
}
test('does not declare unsupported session configuration', () => {
  assert.equal(manifest.capabilities.chatBackend.spawnable, true);
  assert.equal(manifest.capabilities.chatBackend.sessionConfig ?? false, false);
});
test('rejects supplied system instructions before contacting the server', () => {
  const {plugin, calls} = fixture();
  assert.throws(() => plugin.openSession({tabId: 'own-tab', systemPrompt: 'opaque-contract'}),
    error => error.code === 'system_instructions_unsupported');
  assert.equal(calls.length, 0);
});
test('continues to open an instruction-free manual session', () => {
  const {plugin, calls} = fixture();
  assert.equal(plugin.openSession({tabId: 'own-tab', systemPrompt: ''}).sessionId, 'own-tab');
  assert.equal(calls.length, 1);
});
