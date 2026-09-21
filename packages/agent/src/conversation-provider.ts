/** Native session references, never a transcript summary or a 'most recent' session. */
export interface ConversationOrigin {
  provider: "codex";
  sessionId: string;
  /** Inclusive, completed delivery turn. Required so later parent turns cannot leak in. */
  turnId: string;
}

export interface ConversationApproval {
  id: string;
  kind: "command" | "file" | "tool";
  detail: string;
}

export interface ConversationRun {
  signal: AbortSignal;
  approve(request: ConversationApproval): Promise<boolean>;
  tools?: ConversationTools;
  origin?: ConversationOrigin;
}

export interface ConversationTools {
  definitions: Array<{ name: string; description: string; inputSchema: { type: "object"; [key: string]: unknown }; annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean } }>;
  call(name: string, args: unknown): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
  setModel(model: string): void | Promise<void>;
  close(): void;
}

export interface ConversationProvider {
  /** Must return a distinct native session containing the original history. */
  fork(origin: ConversationOrigin, signal: AbortSignal): Promise<string>;
  /** Continue the child, never the original session. */
  prompt(sessionId: string, text: string, run: ConversationRun): Promise<string>;
}

export function parseOrigin(input: unknown): ConversationOrigin {
  if (!input || typeof input !== "object") throw new Error("Expected a native session reference");
  const value = input as Record<string, unknown>;
  if (value.provider !== "codex") throw new Error("Unsupported native session provider");
  for (const key of ["sessionId", "turnId"] as const) {
    if (typeof value[key] !== "string" || !/^[\w-]{1,160}$/.test(value[key])) throw new Error(`Invalid ${key}`);
  }
  return { provider: value.provider, sessionId: value.sessionId as string, turnId: value.turnId as string };
}
