import { ioEncoded, type HostIoSteps } from "@codeterm/plugin-sdk";
import { checkProviderUpdate, type CliCompatibility, type UpdateAvailability } from "../../provider-shared/updateCheck";

export function* checkGrokUpdate(): HostIoSteps<UpdateAvailability | null> {
  let manifest: { cliCompatibility?: CliCompatibility };
  try { manifest = JSON.parse(host.manifestJson() ?? "null"); } catch { return null; }
  if (!manifest?.cliCompatibility?.supported?.length) return null;
  return (yield* checkProviderUpdate({ exec: function* (options: string) { return yield* ioEncoded(host.io.exec(JSON.parse(options))); }, fetch: function* (options: string) { return yield* ioEncoded(host.io.fetch(JSON.parse(options))); } }, "grok", "https://registry.npmjs.org/@xai-official/grok", manifest.cliCompatibility));
}
