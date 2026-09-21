import type { DocHandle } from "@quire/bridge";

export interface AgentRoom {
  handle: DocHandle;
  humanCursors(): Array<{ name: string; index: number }>;
  setAgentPresence(name: string | null): void;
}
