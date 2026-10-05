const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const VERSION = "0.11.0";
const ROOT = path.join(os.homedir(), ".local", "share", "codeterm-plugins", "telegram-client");
const CHECKSUMS = Object.freeze({
  "darwin/amd64": "ace7c122796053662781ce60e736930eb4c25c363c7801407aa3566d15cdcb4a",
  "darwin/arm64": "9e72b09903c69e0a3854dfdac722bd44b99d4f2f5b9721e28bf1fa201f2b62f7",
  "linux/amd64": "3510fcba55aadea2ca1b630766d37fb6dba30c4ab249f9d3adacc60ca75d43c8",
  "linux/arm64": "d26f11be2adfc30c9a9f10aa8f2930d736f83468f452bf814963b1d917c5474b",
  "linux/riscv64": "5864b932e8612c1faf0a7a558f8c4490dc65be9391b4d5b4fb545e0d6cd33059",
  "windows/amd64": "b5b3dab350c073d4058805c3327e849f8ee8cccb6ecd28e668838d10a0be33de",
  "windows/arm64": "da86bfff51891b0f8d6e8d44e60b8e692a34ebd24cb3a6ee56aa661a55d3a482",
});

function normalizePlatform(platform, arch) {
  const osName = ({ macos: "darwin", mac: "darwin", win32: "windows", win: "windows" })[String(platform).toLowerCase()] || String(platform).toLowerCase();
  const archName = ({ x64: "amd64", x86_64: "amd64", aarch64: "arm64", riscv: "riscv64" })[String(arch).toLowerCase()] || String(arch).toLowerCase();
  return `${osName}/${archName}`;
}

function resolveRelease(platform, arch) {
  const key = normalizePlatform(platform, arch);
  const sha256 = CHECKSUMS[key];
  if (!sha256) {
    return { error: "unsupported-platform", message: `No pinned tg ${VERSION} release exists for ${key}.` };
  }
  const [osName, archName] = key.split("/");
  const asset = `tg_${VERSION}_${osName}_${archName}.tar.gz`;
  return { version: VERSION, os: osName, arch: archName, asset, sha256, binary: osName === "windows" ? "tg.exe" : "tg" };
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function verifyArchive(data, expected) {
  return sha256(data).toLowerCase() === String(expected || "").toLowerCase();
}

function tarString(block, start, length) {
  const end = block.indexOf(0, start);
  return block.toString("utf8", start, end >= start && end < start + length ? end : start + length);
}

function tarNumber(block, start, length) {
  const raw = tarString(block, start, length).trim().replace(/\0.*$/, "");
  return raw ? Number.parseInt(raw, 8) : 0;
}

function extractBinary(archive, binaryName) {
  const data = zlib.gunzipSync(archive);
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const member = prefix ? `${prefix}/${name}` : name;
    const size = tarNumber(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > data.length || size < 0) throw new Error("invalid-tar");
    if ((type === "0" || type === "\0") && path.posix.basename(member) === binaryName && !member.includes("..")) {
      return Buffer.from(data.subarray(bodyStart, bodyEnd));
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`release archive does not contain ${binaryName}`);
}

function privateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  replaceFile(temp, file);
}

function replaceFile(temp, file) {
  try { fs.renameSync(temp, file); }
  catch (error) {
    if (!fs.existsSync(file) || !["EEXIST", "EPERM", "EACCES"].includes(error.code)) throw error;
    fs.rmSync(file, { force: true });
    fs.renameSync(temp, file);
  }
}

function recordRefusal(rootDir, state, message) {
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  privateJson(path.join(rootDir, "install-status.json"), { state, message, version: VERSION });
  return { state, message };
}

function installArchive({ platform, arch, archive, rootDir = ROOT }) {
  const release = resolveRelease(platform, arch);
  if (release.error) return recordRefusal(rootDir, release.error, release.message);
  if (!verifyArchive(archive, release.sha256)) {
    return recordRefusal(rootDir, "checksum-mismatch", `Checksum mismatch for pinned ${release.asset}; nothing was installed.`);
  }
  let binary;
  try { binary = extractBinary(archive, release.binary); }
  catch (error) { return recordRefusal(rootDir, "checksum-mismatch", `The verified ${release.asset} could not be safely extracted: ${String(error)}`); }

  const binDir = path.join(rootDir, "bin");
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(rootDir, 0o700);
  fs.chmodSync(binDir, 0o700);
  const target = path.join(binDir, release.binary);
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, binary, { mode: 0o700 });
  fs.chmodSync(temp, 0o700);
  replaceFile(temp, target);
  privateJson(path.join(rootDir, "install.json"), {
    version: release.version,
    asset: release.asset,
    platform: release.os,
    arch: release.arch,
    binary: release.binary,
    sha256: release.sha256,
  });
  fs.rmSync(path.join(rootDir, "install-status.json"), { force: true });
  return { state: "installed", binary: target, version: release.version, asset: release.asset };
}

async function downloadAsset(asset) {
  const url = `https://github.com/gotd/cli/releases/download/v${VERSION}/${asset}`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`release-download-failed (${response.status})`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > 128 * 1024 * 1024) throw new Error("release-asset-too-large");
  return data;
}

async function installPinned({ platform = process.platform, arch = process.arch, rootDir = ROOT, download = downloadAsset } = {}) {
  const release = resolveRelease(platform, arch);
  if (release.error) return recordRefusal(rootDir, release.error, release.message);
  let archive;
  try { archive = await download(release.asset); }
  catch (error) { return recordRefusal(rootDir, "download-failed", `Could not download pinned ${release.asset}: ${String(error)}`); }
  return installArchive({ platform, arch, archive, rootDir });
}

async function main() {
  const result = await installPinned();
  process.stdout.write(`${result.state}: ${result.message || result.binary}\n`);
  if (result.state !== "installed") process.exitCode = 1;
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`tg installer failed: ${String(error)}\n`);
  process.exitCode = 1;
});

module.exports = { VERSION, CHECKSUMS, normalizePlatform, resolveRelease, sha256, verifyArchive, extractBinary, installArchive, installPinned };
