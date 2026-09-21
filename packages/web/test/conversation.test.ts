import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationPanel, conversationRequest, type ConversationStatus } from "../src/conversation.js";
import { setLocale } from "../src/i18n.js";

class Element {
  children: Element[] = [];
  attributes: Record<string, string> = {};
  textContent = "";
  hidden = false;
  disabled = false;
  className = "";
  type = "";
  onclick: (() => Promise<void>) | null = null;
  constructor(readonly tag: string) {}
  prepend(...elements: Element[]) { this.children.unshift(...elements); }
  append(...elements: Element[]) { this.children.push(...elements); }
  replaceChildren() { this.children = []; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  querySelectorAll(tag: string): Element[] { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
}
let parent: Element; let refresh: ReturnType<typeof vi.fn>; let panel: ConversationPanel;
const status: ConversationStatus = { provider: "codex", name: "Codex · Review", label: "Review", state: "connected", error: null, approval: null };
beforeEach(() => {
  vi.stubGlobal("document", { createElement: (tag: string) => new Element(tag), documentElement: {}, querySelectorAll: () => [] });
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  vi.stubGlobal("localStorage", { setItem: vi.fn() });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
  setLocale("en"); parent = new Element("div"); refresh = vi.fn(); panel = new ConversationPanel(parent as unknown as HTMLElement, refresh);
});
afterEach(() => { vi.unstubAllGlobals(); });
it("hides unbound documents and offers no browser Connect action", () => {
  panel.render("report.md", null); expect(parent.children[0]!.hidden).toBe(true);
  panel.render("report.md", status);
  expect(parent.querySelectorAll("strong")[0]!.textContent).toBe("Codex · Review · Connected");
  expect(parent.querySelectorAll("button").map(button => button.textContent)).toEqual(["Disconnect"]);
});
it.each(["command", "file", "tool"] as const)("requires a one-time explicit %s decision", async kind => {
  panel.render("report.md", { ...status, state: "approval", approval: { id: "approval", kind, detail: "<script>not HTML</script>" } });
  expect(fetch).not.toHaveBeenCalled();
  expect(parent.querySelectorAll("pre")[0]!.textContent).toBe("<script>not HTML</script>");
  const button = parent.querySelectorAll("button").find(button => button.textContent === "Approve once")!;
  await button.onclick!();
  expect(fetch).toHaveBeenCalledWith("/api/agent/conversation/decision", expect.objectContaining({ method: "POST", body: JSON.stringify({ doc: "report.md", id: "approval", accepted: true }) }));
  expect(refresh).toHaveBeenCalledOnce();
});
it("renders uncertain state and localizes actions in Chinese", async () => {
  setLocale("zh-CN");
  panel.render("report.md", { ...status, state: "uncertain", error: "Conversation request failed" });
  expect(parent.querySelectorAll("strong")[0]!.textContent).toContain("执行结果不确定");
  const retry = parent.querySelectorAll("button").find(button => button.textContent === "检查会话后重试")!;
  await retry.onclick!();
  expect(fetch).toHaveBeenCalledWith("/api/agent/conversation/retry", expect.objectContaining({ body: JSON.stringify({ doc: "report.md" }) }));
  expect(parent.querySelectorAll("button").at(-1)!.textContent).toBe("断开连接");
});
it("does not submit stale controls after changing documents", async () => {
  panel.render("report.md", status); const old = parent.querySelectorAll("button")[0]!;
  panel.render("another.md", status); await old.onclick!(); expect(fetch).not.toHaveBeenCalled();
});
it("uses a no-store path-only status request and surfaces API errors", async () => {
  await conversationRequest("?path=report.md");
  expect(fetch).toHaveBeenCalledWith("/api/agent/conversation?path=report.md", { cache: "no-store" });
  vi.mocked(fetch).mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Approval expired or belongs to another request" }) } as Response);
  await expect(conversationRequest("/decision", {})).rejects.toThrow(/Approval expired/);
});
