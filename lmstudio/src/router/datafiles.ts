// The install dir is replaced wholesale on every install/upgrade, so user state lives beside it.
export const DATA_DIR_REL = ".codeterm/plugin-data/lmstudio";
export const LEGACY_DIR_REL = ".codeterm/plugins/lmstudio";

/** `~/.codeterm/...` resolves inside the running instance's data dir (`~/.codeterm-dev` on dev). */
export function homePath(rel: string): string | null {
  try {
    const viaFs = host.fs && typeof host.fs.expandHome === "function" ? host.fs.expandHome(`~/${rel}`) : null;
    if (viaFs) return viaFs;
    const viaHost = typeof host.expandHome === "function" ? host.expandHome(`~/${rel}`) : null;
    if (viaHost) return viaHost;
    const home = typeof host.homeDir === "function" ? host.homeDir() : null;
    return home ? `${home.replace(/\/+$/, "")}/${rel}` : null;
  } catch {
    return null;
  }
}

export function dataFilePath(name: string): string | null {
  return homePath(`${DATA_DIR_REL}/${name}`);
}

function readText(path: string | null): string | null {
  if (!path) return null;
  try {
    const text = host.readFile(path);
    return text ? text : null;
  } catch {
    return null;
  }
}

export function writeDataFile(name: string, text: string): boolean {
  const path = dataFilePath(name);
  if (!path) return false;
  try {
    const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (slash > 0 && typeof host.makeDirs === "function") host.makeDirs(path.slice(0, slash));
    return typeof host.writeFileAtomic === "function" ? host.writeFileAtomic(path, text) : host.writeFile(path, text);
  } catch {
    return false;
  }
}

/** Reads the data-dir copy; a file still at the legacy install-dir path is copied over once. */
export function readDataFile(name: string): string | null {
  const current = readText(dataFilePath(name));
  if (current) return current;
  const legacy = readText(homePath(`${LEGACY_DIR_REL}/${name}`));
  if (legacy) writeDataFile(name, legacy);
  return legacy;
}
