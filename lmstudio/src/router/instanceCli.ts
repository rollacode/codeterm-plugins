/** `C:\Users\me\.codeterm-dev\bin` → `/c/Users/me/.codeterm-dev/bin`, the form Git Bash's PATH needs. */
export function posixDir(dir: string): string {
  const unified = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const drive = /^([A-Za-z]):\/(.*)$/.exec(unified);
  return drive ? `/${drive[1].toLowerCase()}/${drive[2]}` : unified;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// The daemon's PATH can resolve `codeterm` to another build (on dev, the app binary itself); the instance CLI lives in <data dir>/bin.
export function withInstanceCli(shellCmd: string, binDir: string | null): string {
  if (!binDir) return shellCmd;
  return `export PATH=${shellQuote(posixDir(binDir))}:"$PATH"; ${shellCmd}`;
}

export function instanceBinDir(): string | null {
  try {
    const dir = host.fs && typeof host.fs.expandHome === "function" ? host.fs.expandHome("~/.codeterm/bin") : null;
    if (!dir) return null;
    const exe = String(host.platform ? host.platform() : "").toLowerCase().indexOf("win") === 0 ? "codeterm.exe" : "codeterm";
    const sep = dir.indexOf("\\") >= 0 ? "\\" : "/";
    return host.fileExists(`${dir.replace(/[\\/]+$/, "")}${sep}${exe}`) ? dir : null;
  } catch {
    return null;
  }
}
