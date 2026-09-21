import type { ConversationOrigin, ConversationProvider, ConversationRun } from "./conversation-provider.js";
import { CodexConversationProvider } from "./codex-conversation.js";

export class NativeConversationProvider implements ConversationProvider {
  private readonly codex: CodexConversationProvider;
  constructor(cwd: string) { this.codex = new CodexConversationProvider(cwd); }
  fork(origin: ConversationOrigin, signal: AbortSignal): Promise<string> {
    return this.codex.fork(origin, signal);
  }
  prompt(sessionId: string, text: string, run: ConversationRun): Promise<string> {
    return this.codex.prompt(sessionId, text, run);
  }
}
