export interface NativeToolCall { id: string; name: string; arguments: string }
export interface ToolPart { index: number; id?: string; name?: string; args: string }
export interface ChatTurn {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: NativeToolCall[];
  toolCallId?: string;
}
export interface Endpoint { id: string; baseUrl: string; secret?: string; models: string[] }
export interface Profile {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  systemPrompt: string;
  root: string;
  allow: string[];
  deny: string[];
  readOnly?: boolean;
  params?: { temperature?: number; top_p?: number; seed?: number };
  budgets: { tokens: number; turns: number; deadlineMs: number };
  targets?: { tabs?: string[]; plans?: string[]; blueprints?: string[] };
}
