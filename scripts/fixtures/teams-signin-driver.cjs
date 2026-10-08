// Runs the Teams sign-in wrapper as a real process, replaces its lease once the URL appears, and reports how it ended.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const [wrapperFile, dir, argsJson] = process.argv.slice(2);
const lease = path.join(dir, "login.lease");
const log = path.join(dir, "login.log");
fs.writeFileSync(lease, "first");
const out = fs.openSync(log, "w");
const child = spawn(process.execPath, ["-e", fs.readFileSync(wrapperFile, "utf8"), lease, "first", "60000", ...JSON.parse(argsJson)], {
  env: { ...process.env, M365_RUNTIME: path.join(dir, "runtime") },
  stdio: ["ignore", out, out],
  windowsHide: true,
});
let port = 0;
const deadline = setTimeout(() => {
  child.kill();
  console.log(JSON.stringify({ error: "timeout", log: fs.readFileSync(log, "utf8") }));
  process.exit(0);
}, 20000);
const tick = setInterval(() => {
  const match = fs.readFileSync(log, "utf8").match(/redirect_uri=http:\/\/localhost:(\d+)/);
  if (match && !port) {
    port = Number(match[1]);
    fs.writeFileSync(lease, "second");
  }
}, 50);
child.on("exit", (code) => {
  clearInterval(tick);
  clearTimeout(deadline);
  const report = (listening) => console.log(JSON.stringify({ code, port, listening, log: fs.readFileSync(log, "utf8") }));
  const socket = net.connect(port, "127.0.0.1");
  socket.on("connect", () => { socket.destroy(); report(true); });
  socket.on("error", () => report(false));
});
