import type { Host, PluginModule } from "@codeterm/plugin-sdk";

declare const host: Host;

const plugin: Pick<PluginModule, "viewCall"> = {
  viewCall(method) {
    if (method === "status") return host.localRecording.status();
    if (method === "enable") return host.localRecording.setEnabled(true);
    if (method === "disable") return host.localRecording.setEnabled(false);
    if (method === "receiverTarget") return host.receiverTarget.get();
    if (method === "resetReceiverTarget") return host.receiverTarget.clear();
    return { error: "unsupported_lark_action" };
  },
};

export default plugin;
