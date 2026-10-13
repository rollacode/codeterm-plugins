import { checkProviderUpdate, type CliCompatibility } from "../../provider-shared/updateCheck";

export function checkAiderUpdate() {
  let manifest: { cliCompatibility?: CliCompatibility };
  try { manifest = JSON.parse(host.manifestJson() ?? "null"); } catch { return null; }
  if (!manifest?.cliCompatibility?.supported?.length) return null;
  return checkProviderUpdate({
    exec: options => host.exec(options),
    fetch: options => {
      try {
        const response = JSON.parse(host.fetch(options));
        if (response.status !== 200) return JSON.stringify(response);
        const metadata = JSON.parse(response.body);
        return JSON.stringify({ ...response, body: JSON.stringify({ versions: metadata.releases }) });
      } catch { return "null"; }
    },
  }, "aider", "https://pypi.org/pypi/aider-chat/json", manifest.cliCompatibility);
}
