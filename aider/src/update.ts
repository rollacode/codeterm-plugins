import { ioEncoded, type HostIoSteps } from "@codeterm/plugin-sdk";
import { checkProviderUpdate, type CliCompatibility, type UpdateAvailability } from "../../provider-shared/updateCheck";

export function* checkAiderUpdate(): HostIoSteps<UpdateAvailability | null> {
  let manifest: { cliCompatibility?: CliCompatibility };
  try { manifest = JSON.parse(host.manifestJson() ?? "null"); } catch { return null; }
  if (!manifest?.cliCompatibility?.supported?.length) return null;
  return (yield* checkProviderUpdate({
    exec: function* (options): HostIoSteps<string> { return (yield* ioEncoded(host.io.exec(JSON.parse(options)))); },
    fetch: function* (options): HostIoSteps<string> {
      try {
        const response = JSON.parse((yield* ioEncoded(host.io.fetch(JSON.parse(options)))));
        if (response.status !== 200) return JSON.stringify(response);
        const metadata = JSON.parse(response.body);
        return JSON.stringify({ ...response, body: JSON.stringify({ versions: metadata.releases }) });
      } catch { return "null"; }
    },
  }, "aider", "https://pypi.org/pypi/aider-chat/json", manifest.cliCompatibility));
}
