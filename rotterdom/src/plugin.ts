import * as harness from "./harness";
import { resolve, settings } from "./config";
import type { ChatBackendOpenSessionCtx } from "@codeterm/plugin-sdk";
import { permitted, offeredTools, relativePath, inside, edited, globPattern } from "./policy";
import { request, response } from "./adapters";
import { claim, complete, recover } from "./history";
import { finishToolCalls, mergeToolParts } from "./toolwire";
import { predefinedProfiles } from "./profiles";
import { domiosCommand } from "./domios";
export default {
  openSession(ctx: ChatBackendOpenSessionCtx) {
    const config = (ctx.config || {}) as { profile?: string; preset?: string; model?: string; systemPrompt?: string };
    if (ctx.mode === "watcher") throw new Error("watcher mode is unsupported");
    const selected = resolve(config.profile || ctx.preset || config.preset, ctx.model || config.model,
      ctx.systemPrompt === undefined ? config.systemPrompt : ctx.systemPrompt);
    return { sessionId: harness.open(ctx.tabId, selected.profile, selected.endpoint, "auto") };
  },
  sendMessage: harness.send,
  pump: harness.pump,
  poll: harness.poll,
  closeSession: harness.close,
  sessionInfo: harness.info,
  setModel: harness.setModel,
  listModels() {
    const s = settings();
    return [...new Set(s.endpoints.flatMap(e => e.models))].map(id => ({ id, displayName: id }));
  },
  listPresets() { return settings().profiles.map(p => ({ id: p.id, name: p.name })); },
  __test: { permitted, offeredTools, relativePath, inside, edited, globPattern, request, response, claim, complete, recover, finishToolCalls, mergeToolParts, predefinedProfiles, domiosCommand, historyTurns: harness.historyTurns },
  profileOpen(id: string, profile: string, resume = false) {
    const selected = resolve(profile);
    return { sessionId: harness.open(id, selected.profile, selected.endpoint, resume) };
  },
  profileSend: harness.send,
  profilePump: harness.pump,
  profilePoll: harness.poll,
  profileClose: harness.close,
};
