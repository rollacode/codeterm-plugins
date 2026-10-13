import { checkProviderUpdate, type CliCompatibility } from "../../provider-shared/updateCheck";

export function checkGrokUpdate() {
  let manifest: { cliCompatibility?: CliCompatibility };
  try { manifest = JSON.parse(host.manifestJson() ?? "null"); } catch { return null; }
  if (!manifest?.cliCompatibility?.supported?.length) return null;
  return checkProviderUpdate(host, "grok", "https://registry.npmjs.org/@xai-official/grok", manifest.cliCompatibility);
}
