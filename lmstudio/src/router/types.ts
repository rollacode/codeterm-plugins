export type ProviderKind = "openai" | "anthropic" | "lmstudio";

export const PROVIDER_KINDS: readonly ProviderKind[] = ["openai", "anthropic", "lmstudio"];

export type ProviderSource = "builtin" | "config" | "user";

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKeySecret: string;
  /** Fallback ids for APIs without a model listing. */
  models: string[];
  enabled: boolean;
  source: ProviderSource;
}

export interface RouterPreset {
  id: string;
  name: string;
  description?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  params?: Record<string, unknown>;
  source: ProviderSource;
}

export interface ModelCapabilities {
  contextLength?: number;
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
}

export interface RouterModel {
  providerId: string;
  id: string;
  displayName: string;
  loaded?: boolean;
  capabilities: ModelCapabilities;
}

export type RouterErrorKind =
  | "denied"
  | "unreachable"
  | "timeout"
  | "auth"
  | "not_found"
  | "http"
  | "parse"
  | "key_missing"
  | "invalid";

export interface RouterError {
  kind: RouterErrorKind;
  message: string;
  status?: number;
}

export interface Usage {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

export interface NativeToolCall {
  id: string;
  name: string;
  /** Raw JSON text exactly as the model produced it. */
  arguments: string;
}

export interface ChatTurn {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: NativeToolCall[];
  toolCallId?: string;
}

export interface ChatRequest {
  model: string;
  system: string;
  turns: ChatTurn[];
  params: Record<string, unknown>;
  tools?: boolean;
}

/** One streamed fragment of a native tool call, keyed by its position in the reply. */
export interface ToolPart {
  index: number;
  id?: string;
  name?: string;
  args: string;
}

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface StreamDelta {
  content: string;
  reasoning: string;
  usage: Usage | null;
  responseId: string | null;
  error: string | null;
  toolParts: ToolPart[];
}
