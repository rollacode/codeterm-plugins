export function stateDir(dataDir: string, pluginId: string): string {
  if (!dataDir || !dataDir.trim()) throw new Error("Host data directory is unavailable");
  if (!/^[a-z][a-z0-9-]*$/.test(pluginId)) throw new Error("Invalid plugin id");
  return `${dataDir.replace(/[\\/]+$/, "")}/${pluginId}`;
}

export function bundleDir(dataDir: string, pluginId: string): string {
  return stateDir(stateDir(dataDir, "plugins"), pluginId);
}
