import * as harness from "./harness";
import { resolve } from "./config";
import { permitted, offeredTools, relativePath, inside, edited, globPattern } from "./policy";
import { request, response } from "./adapters";
import { claim, complete, recover } from "./history";
import { finishToolCalls, mergeToolParts } from "./toolwire";
export default {
  __test: { permitted, offeredTools, relativePath, inside, edited, globPattern, request, response, claim, complete, recover, finishToolCalls, mergeToolParts, historyTurns: harness.historyTurns },
  profileOpen(id: string, profile: string, resume = false) {
    const selected = resolve(profile);
    return { sessionId: harness.open(id, selected.profile, selected.endpoint, resume) };
  },
  profileSend: harness.send,
  profilePump: harness.pump,
  profilePoll: harness.poll,
  profileClose: harness.close,
};
