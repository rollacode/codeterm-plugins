import { METADATA_PROCESS } from "./metadata-process";
// This host-owned foreground job owns bw and dies with its process tree. No vault
// output is retained: only a random loopback port is written to the ready file.
export const SERVE_PROCESS = String.raw`
const { spawn } = require('node:child_process');
const { writeFileSync, unlinkSync, existsSync, statSync, readFileSync } = require('node:fs');
const net = require('node:net');
const { join, delimiter } = require('node:path');
${METADATA_PROCESS.slice(METADATA_PROCESS.indexOf('function executable()'), METADATA_PROCESS.indexOf('function run()'))}
const marker = process.env.CT_BW_READY;
const probe = net.createServer();
let child;
let ready = false;
const finish = () => { try { unlinkSync(marker); } catch {} if (child) child.kill(); process.exit(0); };
process.on('SIGTERM', finish);
process.on('SIGINT', finish);
probe.listen(0, '127.0.0.1', () => {
  const port = probe.address().port;
  probe.close(() => {
    const [bin, prefix] = executable();
    child = spawn(bin, prefix.concat(['serve', '--hostname', '127.0.0.1', '--port', String(port)]), { env: process.env, windowsHide: true, stdio: 'ignore' });
    delete process.env.BW_SESSION;
    // CLI releases differ in whether informational startup logs are enabled.
    // Probe the random port allocated for this child without capturing its output.
    const check = () => {
      if (!child || child.exitCode !== null) return;
      const socket = net.connect({host: '127.0.0.1', port});
      socket.once('connect', () => {
        socket.destroy(); ready = true;
        writeFileSync(marker, JSON.stringify({port}), {mode: 0o600});
      });
      socket.once('error', () => { socket.destroy(); if (!ready) setTimeout(check, 50); });
    };
    check();
    child.on('error', finish); child.on('exit', finish);
  });
});
// Startup and idle leases also bound leftovers after plugin replacement/unload.
const started = Date.now();
setInterval(() => {
  try {
    if (!ready && Date.now() - started > 20000) return finish();
    if (ready && (!existsSync(marker) || Date.now() - statSync(marker).mtimeMs > 300000)) finish();
  } catch { finish(); }
}, 1000);
`;
