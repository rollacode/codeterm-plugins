export const METADATA_PROCESS = String.raw`
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { join, delimiter } = require('node:path');
function fail(message) {
  process.stdout.write(JSON.stringify({ success: false, message }));
}
function executable() {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (process.platform === 'win32') {
      const native = join(dir, 'bw.exe');
      if (existsSync(native)) return [native, []];
      const pkgPath = join(dir, 'node_modules', '@bitwarden', 'cli', 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.bw;
        return [process.execPath, [join(dir, 'node_modules', '@bitwarden', 'cli', bin)]];
      }
    } else {
      const bin = join(dir, 'bw');
      if (existsSync(bin)) return [bin, []];
    }
  }
  return ['bw', []];
}
function run() {
  const [bin, prefix] = executable();
  const result = spawnSync(bin, prefix.concat(process.argv.slice(1)), {
    encoding: 'utf8', env: process.env, shell: false, windowsHide: true,
    timeout: 25000, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    const code = result.error.code;
    return fail(code === 'ETIMEDOUT' ? 'bw metadata timed out' :
      code === 'ENOBUFS' ? 'bw metadata exceeded capture limit' : 'bw metadata could not start');
  }
  let response;
  try { response = JSON.parse(result.stdout); }
  catch { return fail('bw metadata returned invalid JSON'); }
  if (!response || response.success !== true || result.status !== 0) {
    const message = response && typeof response.message === 'string' ? response.message.toLowerCase() : '';
    if (message.includes('vault is locked')) return fail('Vault is locked');
    if (message.includes('you are not logged in')) return fail('You are not logged in');
    return fail('bw metadata failed: exit ' + (Number.isInteger(result.status) ? result.status : -1));
  }
  let data = response.data;
  for (let depth = 0; depth < 8 && data && !Array.isArray(data) && typeof data === 'object'; depth++) {
    data = data.data;
  }
  if (!Array.isArray(data)) return fail('bw metadata returned unexpected shape');
  const items = [];
  for (const c of data) {
    if (!c || typeof c !== 'object') return fail('bw metadata returned unexpected shape');
    if (c.type !== 1) continue;
    if (typeof c.id !== 'string' || typeof c.name !== 'string') return fail('bw metadata returned unexpected shape');
    for (const key of ['folderId', 'organizationId', 'revisionDate']) {
      if (c[key] != null && typeof c[key] !== 'string') return fail('bw metadata returned unexpected shape');
    }
    if (c.collectionIds != null && (!Array.isArray(c.collectionIds) ||
      !c.collectionIds.every(id => typeof id === 'string'))) return fail('bw metadata returned unexpected shape');
    items.push({ type: 1, id: c.id, name: c.name, folderId: c.folderId,
      organizationId: c.organizationId, collectionIds: c.collectionIds, revisionDate: c.revisionDate });
  }
  const output = JSON.stringify({ success: true, data: items });
  if (Buffer.byteLength(output) > 120 * 1024) return fail('bw metadata exceeded host output limit');
  process.stdout.write(output);
}
try { run(); } catch { fail('bw metadata process failed'); }
`;
