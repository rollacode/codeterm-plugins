import { openAiMessage, pairToolCalls } from "./toolwire";
import type { ChatTurn, Endpoint, Profile } from "./types";
import { offeredTools } from "./policy";
import { openAiTools } from "./toolspec";
export function request(endpoint: Endpoint, profile: Profile, turns: ChatTurn[], key: string | null, remainingTokens: number) {
  if (!/^https?:\/\/[^\s?#]+$/.test(endpoint.baseUrl) || /\/\/[^/]*@/.test(endpoint.baseUrl)) throw new Error("invalid endpoint URL");
  const tools = openAiTools(offeredTools(profile));
  return { url: `${endpoint.baseUrl.replace(/\/+$/, "")}/chat/completions`, method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ ...profile.params, model: profile.model, stream: false,
      max_tokens: Math.min(4096, remainingTokens),
      messages: [{ role: "system", content: profile.systemPrompt }, ...pairToolCalls(turns).map(openAiMessage)],
      ...(tools.length ? { tools, tool_choice: "auto" } : {}) }), timeoutMs: profile.budgets.deadlineMs };
}
export function response(raw: string): { turn: ChatTurn; tokens: number } {
  const data = JSON.parse(raw);
  if (data.error) throw new Error(String(data.error.message || "endpoint error"));
  const message = data.choices?.[0]?.message;
  if (!message || (message.content != null && typeof message.content !== "string")) throw new Error("invalid assistant response");
  const calls = message.tool_calls;
  if (calls !== undefined && (!Array.isArray(calls) || calls.length > 16)) throw new Error("invalid tool calls");
  const ids = new Set<string>();
  const toolCalls = (calls || []).map((c: any) => {
    if (typeof c.id !== "string" || !c.id || ids.has(c.id) || c.type !== "function"
      || typeof c.function?.name !== "string" || typeof c.function?.arguments !== "string") throw new Error("invalid tool call");
    ids.add(c.id);
    return { id: c.id, name: c.function.name, arguments: c.function.arguments };
  });
  const tokens = data.usage?.total_tokens;
  if (!Number.isInteger(tokens) || tokens < 0) throw new Error("endpoint must report token usage for the token budget");
  return { turn: { role: "assistant", content: message.content || "", ...(toolCalls.length ? { toolCalls } : {}) }, tokens };
}
