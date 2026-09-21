import { getLocale, t } from "./i18n.js";

export interface ConversationStatus {
  provider: "codex";
  name: string;
  label: string | null;
  state: "connecting" | "connected" | "working" | "approval" | "failed" | "uncertain";
  error: string | null;
  approval: { id: string; kind: "command" | "file" | "tool"; detail: string } | null;
}

export async function conversationRequest(path: string, body?: Record<string, unknown>): Promise<ConversationStatus | null> {
  const response = await fetch(`/api/agent/conversation${path}`, body ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  } : { cache: "no-store" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Conversation request failed");
  return result;
}

export class ConversationPanel {
  private readonly element = document.createElement("section");
  private signature = "";
  private generation = 0;
  constructor(parent: HTMLElement, private readonly refresh: () => void) {
    this.element.className = "artifact-conversation";
    this.element.hidden = true;
    parent.prepend(this.element);
  }
  render(doc: string | null, status: ConversationStatus | null): void {
    const signature = JSON.stringify([doc, status, getLocale()]);
    if (signature === this.signature) return;
    this.signature = signature;
    const generation = ++this.generation;
    this.element.replaceChildren();
    this.element.hidden = !doc || !status;
    this.element.setAttribute("aria-label", t("Artifact conversation"));
    if (!doc || !status) return;
    const title = document.createElement("strong");
    const state = { connecting: "Connecting…", connected: "Connected", working: "Working…", approval: "Your approval needed", failed: "Connection failed", uncertain: "Run outcome uncertain" }[status.state];
    title.textContent = `${status.name} · ${t(state)}`;
    title.setAttribute("role", "status");
    const note = document.createElement("p");
    note.textContent = t("Comments continue a separate copy of the originating conversation. The original chat is unchanged.");
    this.element.append(title, note);
    const action = (label: string, path: string, body: Record<string, unknown>) => {
      const button = document.createElement("button"); button.type = "button"; button.textContent = t(label);
      button.onclick = async () => {
        if (generation !== this.generation) return;
        const buttons = [...this.element.querySelectorAll("button")]; buttons.forEach(item => item.disabled = true);
        try { await conversationRequest(`/${path}`, { doc, ...body }); this.signature = ""; this.refresh(); }
        catch (error) {
          if (generation !== this.generation) return;
          const failure = document.createElement("p"); failure.textContent = t(error instanceof Error ? error.message : "Conversation request failed");
          failure.setAttribute("role", "alert"); this.element.append(failure); buttons.forEach(item => item.disabled = false);
        }
      };
      this.element.append(button);
    };
    if (status.approval) {
      const kind = document.createElement("p");
      kind.textContent = t({ command: "Command approval", file: "File change approval", tool: "Tool approval" }[status.approval.kind]);
      const detail = document.createElement("pre"); detail.textContent = status.approval.detail;
      this.element.append(kind, detail);
      action("Approve once", "decision", { id: status.approval.id, accepted: true });
      action("Decline", "decision", { id: status.approval.id, accepted: false });
    }
    if (status.error) {
      const error = document.createElement("p"); error.textContent = t(status.error); error.setAttribute("role", "alert");
      this.element.append(error);
      if (status.state === "uncertain" || status.state === "failed") action("Retry after checking session", "retry", {});
    }
    action("Disconnect", "disconnect", {});
  }
}
