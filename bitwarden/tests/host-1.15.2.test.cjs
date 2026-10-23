const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const contract = require('./fixtures/host-1.15.2.json');
const bundle = readFileSync(join(__dirname, '..', 'plugin.js'), 'utf8');
const sentinel = 'VAULT-VALUE-MUST-STAY-IN-PLUGIN-1152';
const item = {
  id: 'item-1', type: 1, name: 'token', folderId: 'folder-1',
  organizationId: 'org-1', collectionIds: ['collection-1'],
  revisionDate: '2026-01-01T00:00:00.000Z',
  login: { password: sentinel, username: sentinel, totp: sentinel, uris: [sentinel] },
  notes: sentinel, fields: [{ value: sentinel }], attachments: [{ fileName: sentinel }],
};
const expected = [{ item_id: 'item-1', name: 'token', folder: 'folder-1',
  organization: 'org-1', collection: 'collection-1', last_modified: 1767225600000 }];
const calls = [
  ['secretList', [{ folder: null, organization: null, collection: null, limit: null }]],
  ['secretSearch', ['token']],
];

function replay(method, args, exec) {
  const commands = [];
  const sandbox = { module: { exports: {} }, host: {
    platform: () => 'win32',
    secretGet: (key) => key === 'session' ? 'mock-session' : null,
    exec: (raw) => { commands.push(JSON.parse(raw)); return exec(JSON.parse(raw)); },
  } };
  vm.createContext(sandbox);
  vm.runInContext(bundle, sandbox);
  sandbox.__plugin__ = sandbox.module.exports.default;
  sandbox.__ct_method__ = method;
  sandbox.__ct_args__ = JSON.stringify(args);
  vm.runInContext(contract.invoke, sandbox);
  const wire = vm.runInContext('__ct_invoke__()', sandbox);
  assert(!wire.includes(sentinel), 'plugin wire must contain no item value');
  return { envelope: JSON.parse(wire), commands };
}

function decode(envelope) {
  if (envelope.error != null) return { error: envelope.error };
  assert(Array.isArray(envelope.ok), 'Envelope<Vec<SecretRef>> requires ok array');
  for (const ref of envelope.ok) {
    assert.equal(typeof ref.item_id, 'string');
    assert.equal(typeof ref.name, 'string');
    for (const key of ['folder', 'organization', 'collection']) {
      assert(ref[key] == null || typeof ref[key] === 'string');
    }
    assert(ref.last_modified == null || Number.isSafeInteger(ref.last_modified));
  }
  return envelope;
}

function execResult(body, overrides = {}) {
  return () => JSON.stringify({ code: 0, stdout: JSON.stringify(body), stderr: '', ...overrides });
}

test('pinned 1.15.2 source names calls, envelope and metadata schema', () => {
  assert.equal(contract.tag, 'v1.15.2');
  assert(contract.commit.startsWith('d926b1bac'));
  assert.match(contract.backend, /"secretList",\s*vec!\[serde_json::to_value\(&filter\)/);
  assert.match(contract.backend, /call::<Vec<SecretRef>>\("secretSearch", vec!\[json!\(query\)\]\)/);
  assert.match(contract.backend, /ok: Option<T>/);
  assert.match(contract.backend, /error: Option<SecretError>/);
  assert.match(contract.secretRef, /last_modified: Option<i64>/);
  assert.match(contract.boundedOutput, /const LIMIT: usize = 128 \* 1024/);
  assert.throws(() => decode({ success: true, data: [] }), /requires ok array/);
});

for (const [method, args] of calls) {
  test(`${method}: exact host invocation decodes only metadata`, () => {
    for (const data of [[item], { object: 'list', data: [item] },
      { success: true, data: { object: 'list', data: [item] } }]) {
      const result = replay(method, args, execResult({ success: true, data }));
      assert.deepEqual(decode(result.envelope), { ok: expected });
      assert.equal(result.commands[0].bin, 'node');
      assert.equal(result.commands[0].args[0], '-e');
      assert.deepEqual(result.commands[0].args.slice(3), method === 'secretList'
        ? ['list', 'items', '--nointeraction', '--response']
        : ['list', 'items', '--search', 'token', '--nointeraction', '--response']);
    }
    assert.deepEqual(decode(replay(method, args, execResult({ success: true, data: [] })).envelope), { ok: [] });
  });

  test(`${method}: all malformed metadata fields fail closed`, () => {
    for (const key of ['folderId', 'organizationId', 'revisionDate', 'collectionIds']) {
      const bad = { ...item, [key]: key === 'collectionIds' ? [{ login: sentinel }] : { login: sentinel } };
      assert.equal(decode(replay(method, args, execResult({ success: true, data: [bad] })).envelope).error.kind, 'backend');
    }
  });

  test(`${method}: transport, bw and thrown errors never embed bw output`, () => {
    const payload = JSON.stringify({ success: true, data: { object: 'list', data: [item] } });
    for (const exec of [
      execResult({}, { stdout: '', stderr: payload, code: 1 }),
      execResult({}, { stdout: payload.slice(0, -1) }),
      execResult({}, { error: payload }),
      execResult({}, { stdout: payload.slice(0, 100), truncated: true }),
      execResult({ success: false, message: payload }),
      execResult({ success: false, message: { payload } }),
      execResult({ success: true, data: { unexpected: item } }),
      () => { throw new Error(payload); },
      () => payload,
      () => sentinel,
    ]) {
      assert.equal(decode(replay(method, args, exec).envelope).error.kind, 'backend');
    }
  });
}

function projectProcess(opts, result, platform = 'linux', files = {}) {
  let wire = '';
  let captured;
  const context = {
    Buffer,
    process: { platform, execPath: '/mock/node', argv: ['/mock/node', ...opts.args.slice(3)],
      env: { PATH: '/mock/bin', BW_SESSION: 'mock-session' },
      stdout: { write: (text) => { wire += text; } } },
    require: (id) => {
      if (id === 'node:path') return require('node:path').posix;
      if (id === 'node:fs') return { existsSync: (path) => path in files, readFileSync: (path) => files[path] };
      if (id === 'node:child_process') return { spawnSync: (bin, args, options) => {
        captured = { bin, args, options };
        return result;
      } };
      throw new Error('Unexpected dependency');
    },
  };
  vm.runInNewContext(opts.args[1], context);
  assert(!wire.includes(sentinel), 'subprocess stdout contains no item value');
  assert(wire.length <= 120 * 1024);
  return { wire, captured };
}

for (const [method, args] of calls) {
  test(`${method}: large raw vault is projected before 1.15.2 capture`, () => {
    const large = { success: true, data: { object: 'list', data: [{ ...item, notes: sentinel.repeat(20000) }] } };
    const raw = JSON.stringify(large);
    assert(Buffer.byteLength(raw) > 128 * 1024);
    const result = replay(method, args, (opts) => {
      const projected = projectProcess(opts, { status: 0, stdout: raw, stderr: sentinel });
      assert.equal(projected.captured.options.shell, false);
      assert.equal(projected.captured.options.env.BW_SESSION, 'mock-session');
      assert(projected.captured.args.includes('--response'));
      return JSON.stringify({ code: 0, stdout: projected.wire.slice(0, 128 * 1024), stderr: '' });
    });
    assert.deepEqual(decode(result.envelope), { ok: expected });
  });

  test(`${method}: subprocess failures have bounded safe kinds`, () => {
    for (const [result, message] of [
      [{ status: 7, stdout: JSON.stringify({ success: false, message: sentinel }), stderr: sentinel }, 'bw metadata failed: exit 7'],
      [{ error: { code: 'ENOBUFS', message: sentinel } }, 'bw metadata exceeded capture limit'],
      [{ error: { code: 'ETIMEDOUT', message: sentinel } }, 'bw metadata timed out'],
      [{ error: { code: 'ENOENT', message: sentinel } }, 'bw metadata could not start'],
      [{ status: 0, stdout: sentinel }, 'bw metadata returned invalid json'],
      [{ status: 0, stdout: JSON.stringify({ success: true, data: { value: sentinel } }) }, 'bw metadata returned unexpected shape'],
      [{ status: 0, stdout: JSON.stringify({ success: true, data: [{ ...item, name: 'n'.repeat(128 * 1024) }] }) }, 'bw metadata exceeded host output limit'],
    ]) {
      const actual = replay(method, args, (opts) => JSON.stringify({ code: 0,
        stdout: projectProcess(opts, result).wire, stderr: '' })).envelope;
      assert.deepEqual(decode(actual), { error: { kind: 'backend', message } });
    }
  });
}

test('Windows npm CLI is invoked through node without a command shell', () => {
  replay('secretSearch', ['token & echo should-stay-an-argument'], (opts) => {
    const result = projectProcess(opts, { status: 0, stdout: JSON.stringify({ success: true, data: [] }) },
      'win32', { '/mock/bin/node_modules/@bitwarden/cli/package.json': JSON.stringify({ bin: { bw: 'build/bw.js' } }) });
    assert.equal(result.captured.bin, '/mock/node');
    assert.equal(result.captured.args[0], '/mock/bin/node_modules/@bitwarden/cli/build/bw.js');
    assert(result.captured.args.includes('token & echo should-stay-an-argument'));
    assert.equal(result.captured.options.shell, false);
    return JSON.stringify({ code: 0, stdout: result.wire });
  });
});
