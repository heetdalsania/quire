import { execFileSync, spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentStore, Vault, knownAuthors, registerAuthor } from "@quire/bridge";
import { ArtifactConversations } from "../src/conversations.js";
import type { AgentRoom } from "../src/room.js";
import { BindingStore, bindingFileName } from "../src/binding-store.js";
import type { ConversationProvider } from "../src/conversation-provider.js";

let root: string; let vault: Vault; let manager: ArtifactConversations; let room: AgentRoom; let store: CommentStore;
let provider: ConversationProvider;
const origin = { provider: "codex", sessionId: "original", turnId: "delivery" };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "quire-conversation-"));
  await writeFile(join(root, "report.md"), "The original report.\n");
  vault = await Vault.open({ root });
  room = { handle: vault.getDoc("report.md"), humanCursors: () => [], setAgentPresence: vi.fn() };
  store = new CommentStore(room.handle.doc);
  provider = { fork: vi.fn(async () => "native-child"), prompt: vi.fn(async () => "Native answer") };
  manager = new ArtifactConversations(vault, provider);
});
afterEach(async () => { await manager.close(); await vault.close(); await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
const add = (body = "Explain this") => store.add({ text: room.handle.text, from: 0, to: 12, body, authorId: "human", authorName: "Human" });
const idle = () => vi.waitFor(() => expect(manager.busy("report.md")).toBe(false));

describe("artifact conversations", () => {
  it("rolls back a binding disconnected while its initial atomic save is in flight", async () => {
    const save = BindingStore.prototype.save;
    let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(BindingStore.prototype, "save").mockImplementationOnce(async function(this: BindingStore, bindings) {
      entered(); await waiting; return save.call(this, bindings);
    });
    const connecting = manager.bind(room, origin, true);
    const checked = expect(connecting).rejects.toThrow();
    await started;
    const disconnecting = manager.unbind("report.md");
    release(); await checked; await disconnecting;
    expect(manager.status("report.md")).toBeNull();
    expect(await readdir(join(root, ".quire/conversations"))).toEqual([".gitignore"]);
    expect(provider.prompt).not.toHaveBeenCalled();
  });
  it("does not redispatch an already consumed human revision after edits revert", async () => {
    await manager.bind(room, origin); const id = add(); await idle();
    const thread = [...store.yarray].find(thread => thread.get("id") === id)!;
    thread.set("body", "Different request"); await idle();
    thread.set("body", "Explain this"); await idle();
    expect(provider.prompt).toHaveBeenCalledTimes(2);
  });
  it("does not persist or publish raw runtime errors and their possible credentials", async () => {
    vi.mocked(provider.prompt).mockRejectedValue(new Error("original native-child Bearer SECRET_TRANSCRIPT"));
    await manager.bind(room, origin); add(); await idle();
    expect(JSON.stringify(manager.status("report.md"))).not.toMatch(/original|native-child|Bearer|SECRET_TRANSCRIPT/);
    const state = JSON.parse(await readFile(join(root, ".quire/conversations", bindingFileName("report.md")), "utf8"));
    expect(state.error).toBe("uncertain");
    expect(JSON.stringify(state)).not.toMatch(/Bearer|SECRET_TRANSCRIPT/);
  });
  it("persists dispatch and model before execution without storing transcripts or exposing native identifiers", async () => {
    const privateOrigin = { provider: "codex", sessionId: "private-source-123", turnId: "delivery-456" };
    vi.mocked(provider.fork).mockResolvedValue("private-child-789");
    const path = join(root, ".quire/conversations", bindingFileName("report.md"));
    vi.mocked(provider.prompt).mockImplementation(async (_session, _text, run) => {
      const dispatched = JSON.parse(await readFile(path, "utf8"));
      expect(dispatched.active).toBe(store.list()[0]!.id);
      expect(dispatched.receipts[0].state).toBe("dispatched");
      await run.tools!.setModel("fixture-model");
      expect(JSON.parse(await readFile(path, "utf8")).receipts[0].model).toBe("fixture-model");
      const decision = run.approve({ id: "approval", kind: "tool", detail: "private-source-123 private-child-789" });
      expect(JSON.stringify(manager.status("report.md"))).not.toMatch(/private-source-123|private-child-789|delivery-456/);
      manager.decide("report.md", "approval", false);
      await decision;
      return "private-source-123 private-child-789 Secret transcript content";
    });
    await manager.bind(room, privateOrigin, false, undefined, "Editorial review");
    add("Private human request"); await idle();
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.authorId).toMatch(/^agent-native-[a-f0-9]{16}$/);
    expect(saved.receipts[0]).toMatchObject({ state: "completed", model: "fixture-model" });
    expect(JSON.stringify(saved.receipts)).not.toMatch(/private-source-123|private-child-789|Secret transcript|Private human request|answer/);
    expect(JSON.stringify(room.handle.doc.toJSON())).not.toMatch(/private-source-123|private-child-789/);
    expect(knownAuthors(room.handle.doc)[saved.authorId]).toMatchObject({ name: "Codex · Editorial review", kind: "agent" });
    await manager.close(); manager = new ArtifactConversations(vault, provider); await manager.load(); manager.attach(room);
    expect(JSON.parse(await readFile(path, "utf8")).authorId).toBe(saved.authorId);
    expect(manager.status("report.md")?.name).toBe("Codex · Editorial review");
  });
  it("uses atomic private per-document files and removes only the disconnected binding", async () => {
    await writeFile(join(root, "other.md"), "Other report.");
    await vi.waitFor(() => expect(vault.list()).toContain("other.md"));
    await manager.bind(room, origin);
    await manager.bind({ ...room, handle: vault.getDoc("other.md") }, origin);
    const directory = join(root, ".quire/conversations");
    expect((await readdir(directory)).sort()).toEqual([".gitignore", bindingFileName("report.md"), bindingFileName("other.md")].sort());
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      for (const file of await readdir(directory)) expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
    }
    await manager.unbind("report.md");
    expect((await readdir(directory)).sort()).toEqual([".gitignore", bindingFileName("other.md")].sort());
  });
  it.skipIf(spawnSync("git", ["--version"]).status !== 0)("ignores private routing JSON and temporary files without hiding the rest of .quire", async () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init");
    await manager.bind(room, origin);
    const directory = join(root, ".quire/conversations");
    await writeFile(join(directory, "unfinished.tmp"), "private routing data");
    await writeFile(join(root, ".quire/settings.txt"), "visible settings");
    const files = git("ls-files", "--others", "--exclude-standard").trim().split("\n");
    expect(files.filter(file => file.startsWith(".quire/conversations/"))).toEqual([".quire/conversations/.gitignore"]);
    expect(files).toContain(".quire/settings.txt");
    const status = git("status", "--porcelain", "--untracked-files=all");
    expect(status).not.toMatch(/\.quire\/conversations\/.*\.(json|tmp)/);
    expect(git("check-ignore", "-v", `.quire/conversations/${bindingFileName("report.md")}`)).toContain(".quire/conversations/.gitignore:1:*.json");
  });
  it("recreates the ignore file and preserves it across loading and stale binding removal", async () => {
    await manager.bind(room, origin);
    const path = join(root, ".quire/conversations/.gitignore");
    await rm(path);
    add(); await idle();
    expect(await readFile(path, "utf8")).toBe("*.json\n*.tmp\n");
    await manager.close();
    manager = new ArtifactConversations(vault, provider);
    await manager.load();
    expect(manager.paths()).toEqual(["report.md"]);
    await manager.unbind("report.md");
    expect(await readdir(join(root, ".quire/conversations"))).toEqual([".gitignore"]);
  });
  it("replaces a pre-existing ignore symlink without writing to its target", async () => {
    const directory = join(root, ".quire/conversations");
    const target = join(root, "ignore-target.txt");
    await mkdir(directory, { recursive: true });
    await writeFile(target, "Do not change\n");
    await symlink(target, join(directory, ".gitignore"));
    await manager.bind(room, origin);
    expect(await readFile(target, "utf8")).toBe("Do not change\n");
    expect((await lstat(join(directory, ".gitignore"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(directory, ".gitignore"), "utf8")).toBe("*.json\n*.tmp\n");
  });
  it("does not write binding files if the ignore file cannot be installed", async () => {
    const directory = join(root, ".quire/conversations");
    await mkdir(join(directory, ".gitignore"), { recursive: true });
    await expect(manager.bind(room, origin)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([".gitignore"]);
  });
  it("refuses symlinked state directories and binding files", async () => {
    await manager.bind(room, origin); await manager.close();
    const directory = join(root, ".quire/conversations");
    const target = join(root, "state-target.json");
    const path = join(directory, bindingFileName("report.md"));
    await rename(path, target); await symlink(target, path);
    manager = new ArtifactConversations(vault, provider);
    await expect(manager.load()).rejects.toThrow();
    await rm(directory, { recursive: true });
    await symlink(root, directory, process.platform === "win32" ? "junction" : "dir");
    await expect(manager.load()).rejects.toThrow(/symlink/);
  });
  it("does not invoke the provider when persisting dispatch fails", async () => {
    await manager.bind(room, origin);
    vi.spyOn(BindingStore.prototype, "save").mockRejectedValueOnce(new Error("disk full"));
    add(); await idle();
    expect(provider.prompt).not.toHaveBeenCalled();
    expect(manager.status("report.md")?.state).toBe("uncertain");
  });
  it("disconnects an active turn and prevents queued comments from dispatching", async () => {
    vi.mocked(provider.prompt).mockImplementation(async (_session, _text, run) => {
      return new Promise((_resolve, reject) => run.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    });
    await manager.bind(room, origin); add();
    await vi.waitFor(() => expect(provider.prompt).toHaveBeenCalledTimes(1));
    add("Queued request"); await manager.unbind("report.md");
    expect(manager.status("report.md")).toBeNull();
    expect(provider.prompt).toHaveBeenCalledTimes(1);
    expect(await readdir(join(root, ".quire/conversations"))).toEqual([".gitignore"]);
  });
  it("answers comments and follow-ups submitted during the fork without replaying old comments", async () => {
    const old = add("Leave this existing comment alone");
    const followed = add("An existing thread with a new follow-up");
    let complete!: (session: string) => void;
    vi.mocked(provider.fork).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const connecting = manager.bind(room, origin);
    const added = add("Posted while connecting");
    store.reply(followed, "Follow-up while connecting", "human", "Human");
    complete("native-child"); await connecting; await idle();
    expect(provider.prompt).toHaveBeenCalledTimes(2);
    expect(store.list().find(thread => thread.id === old)!.replies).toHaveLength(0);
    for (const id of [followed, added]) expect(store.list().find(thread => thread.id === id)!.replies.at(-1)!.body).toBe("Native answer");
  });
  it("refuses a fork whose document was renamed and keeps ownership until the fork settles", async () => {
    let complete!: (session: string) => void;
    let signal!: AbortSignal;
    vi.mocked(provider.fork).mockImplementation((_origin, input) => { signal = input; return new Promise(resolve => { complete = resolve; }); });
    const connecting = manager.bind(room, origin);
    const checked = expect(connecting).rejects.toThrow(/renamed|identity/);
    await rename(join(root, "report.md"), join(root, "renamed.md"));
    await vi.waitFor(() => expect(room.handle.path).toBe("renamed.md"));
    expect(signal.aborted).toBe(true);
    expect(manager.owns("renamed.md")).toBe(true);
    expect(manager.busy("renamed.md")).toBe(true);
    complete("native-child"); await checked;
    expect(manager.paths()).toEqual([]);
    expect(manager.owns("report.md")).toBe(false); expect(manager.owns("renamed.md")).toBe(false);
    await expect(readFile(join(root, ".quire/conversations", bindingFileName("report.md")))).rejects.toThrow(/ENOENT/);
    vi.mocked(provider.fork).mockResolvedValue("replacement-child");
    await manager.bind(room, origin);
    expect(manager.status("renamed.md")?.state).toBe("connected");
    const saved = JSON.parse(await readFile(join(root, ".quire/conversations", bindingFileName("renamed.md")), "utf8"));
    expect(saved.doc).toBe("renamed.md");
  });
  it("refuses a fork whose document was deleted", async () => {
    let complete!: (session: string) => void;
    vi.mocked(provider.fork).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const connecting = manager.bind(room, origin);
    const checked = expect(connecting).rejects.toThrow(/deleted|identity/);
    await rm(join(root, "report.md"));
    await vi.waitFor(() => expect(room.handle.deleted).toBe(true), { timeout: 3000 });
    complete("native-child"); await checked;
    expect(manager.paths()).toEqual([]);
  });
  it("waits for an in-flight fork to stop before closing", async () => {
    let complete!: (session: string) => void;
    let signal!: AbortSignal;
    vi.mocked(provider.fork).mockImplementation((_origin, input) => { signal = input; return new Promise(resolve => { complete = resolve; }); });
    const connecting = manager.bind(room, origin);
    const checked = expect(connecting).rejects.toThrow();
    let closed = false;
    const closing = manager.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(signal.aborted).toBe(true); expect(closed).toBe(false);
    complete("native-child"); await checked; await closing;
    expect(manager.paths()).toEqual([]);
  });
  it("forks at an explicit delivery point and reuses the child across comments and restart", async () => {
    const old = add("Existing comment");
    await manager.bind(room, origin);
    expect(provider.fork).toHaveBeenCalledWith(origin, expect.any(AbortSignal));
    expect(provider.prompt).not.toHaveBeenCalled();
    const first = add(); await idle();
    expect(provider.prompt).toHaveBeenCalledTimes(1);
    expect(vi.mocked(provider.prompt).mock.calls[0]![0]).toBe("native-child");
    expect(vi.mocked(provider.prompt).mock.calls[0]![1]).toContain("The original report");
    expect(vi.mocked(provider.prompt).mock.calls[0]![1]).toContain("Artifact: report.md");
    expect(vi.mocked(provider.prompt).mock.calls[0]![1]).not.toContain(vault.root);
    expect(store.list().find(t => t.id === old)!.replies).toHaveLength(0);
    expect(store.list().find(t => t.id === first)!.replies.at(-1)!.body).toBe("Native answer");
    store.reply(first, "And what follows?", "human", "Human"); await idle();
    expect(provider.prompt).toHaveBeenCalledTimes(2);
    await manager.close(); await vault.close();
    vault = await Vault.open({ root });
    room = { ...room, handle: vault.getDoc("report.md") }; store = new CommentStore(room.handle.doc);
    manager = new ArtifactConversations(vault, provider); await manager.load(); manager.attach(room); await idle();
    expect(provider.prompt).toHaveBeenCalledTimes(2);
    add("A new topic"); await idle();
    expect(provider.fork).toHaveBeenCalledTimes(1);
    expect(vi.mocked(provider.prompt).mock.calls.map(call => call[0])).toEqual(["native-child", "native-child", "native-child"]);
  });
  it("ignores agent self-events", async () => {
    await manager.bind(room, origin);
    const id = add(); await idle();
    await new Promise(resolve => setTimeout(resolve, 450));
    expect(store.list()[0]!.replies.map(r => r.body)).toEqual(["👀 received · reading…", "Native answer"]);
    registerAuthor(room.handle.doc, { id: "another-agent", name: "Other", kind: "agent", color: "blue" });
    store.reply(id, "External observation", "another-agent", "Other"); await idle();
    expect(provider.prompt).toHaveBeenCalledTimes(1);
  });
  it("continues human discussion after its quoted passage was deleted", async () => {
    await manager.bind(room, origin);
    const id = add(); await idle();
    room.handle.text.delete(0, room.handle.text.length);
    room.handle.text.insert(0, "The revised report.\n");
    expect(store.list()[0]!.orphaned).toBe(true);
    store.reply(id, "Explain the revision", "human", "Human"); await idle();
    expect(provider.prompt).toHaveBeenCalledTimes(2);
    const call = vi.mocked(provider.prompt).mock.calls[1]!;
    expect(call[0]).toBe("native-child");
    expect(call[1]).toContain("The revised report");
    expect(call[1]).toContain('"orphaned":true');
    expect(store.list()[0]!.quote).toBe("The original");
    expect(store.list()[0]!.replies.at(-1)!.body).toBe("Native answer");
  });
  it("serializes human follow-ups arriving during an active turn", async () => {
    const resolvers: Array<(value: string) => void> = [];
    vi.mocked(provider.prompt).mockImplementation(async () => new Promise(resolve => resolvers.push(resolve)));
    await manager.bind(room, origin);
    const id = add(); await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    store.reply(id, "Another detail", "human", "Human");
    expect(provider.prompt).toHaveBeenCalledTimes(1);
    resolvers.shift()!("First answer"); await vi.waitFor(() => expect(provider.prompt).toHaveBeenCalledTimes(2));
    expect(vi.mocked(provider.prompt).mock.calls[1]![1]).toContain("Another detail");
    resolvers.shift()!("Follow-up answer"); await idle();
    expect(store.list()[0]!.replies.map(r => r.body)).toEqual(["👀 received · reading…", "Another detail", "First answer", "👀 received · reading…", "Follow-up answer"]);
  });
  it("holds native approval until an explicit matching decision and rejects stale decisions", async () => {
    vi.mocked(provider.prompt).mockImplementation(async (_session, _text, run) => {
      const accepted = await run.approve({ id: "approval-1", kind: "command", detail: "git diff" });
      return accepted ? "Approved" : "Declined";
    });
    await manager.bind(room, origin); add();
    await vi.waitFor(() => expect(manager.status("report.md")?.state).toBe("approval"));
    expect(store.list()[0]!.replies.map(r => r.body)).toEqual(["👀 received · reading…"]);
    expect(() => manager.decide("report.md", "wrong", true)).toThrow(/expired/);
    manager.decide("report.md", "approval-1", false); await idle();
    expect(store.list()[0]!.replies.at(-1)!.body).toBe("Declined");
    expect(() => manager.decide("report.md", "approval-1", true)).toThrow(/expired/);
  });
  it("does not auto-retry uncertain native failures or an interrupted persisted turn", async () => {
    vi.mocked(provider.prompt).mockRejectedValueOnce(new Error("Native connection lost"));
    await manager.bind(room, origin); add(); await idle();
    expect(manager.status("report.md")?.error).toContain("uncertain");
    add("Queued while offline"); await idle(); expect(provider.prompt).toHaveBeenCalledTimes(1);
    await manager.retry("report.md"); await idle(); expect(provider.prompt).toHaveBeenCalledTimes(2);
    await manager.close();
    const path = join(root, ".quire/conversations", bindingFileName("report.md")); const state = JSON.parse(await readFile(path, "utf8"));
    state.active = "interrupted"; await writeFile(path, JSON.stringify(state));
    manager = new ArtifactConversations(vault, provider); await manager.load(); manager.attach(room);
    expect(manager.status("report.md")?.error).toContain("actions may already have run");
    expect(provider.prompt).toHaveBeenCalledTimes(2);
  });
  it("follows a document rename and pauses on deletion", async () => {
    await manager.bind(room, origin);
    room.handle.path = "renamed.md";
    vault.emit("doc:rename", { from: "report.md", to: "renamed.md" });
    expect(manager.owns("report.md")).toBe(false); expect(manager.owns("renamed.md")).toBe(true);
    add(); await vi.waitFor(() => expect(store.list()[0]!.replies.at(-1)?.body).toBe("Native answer"));
    expect(vi.mocked(provider.prompt).mock.calls[0]![1]).toContain("renamed.md");
    vault.emit("doc:delete", { path: "renamed.md" });
    expect(manager.status("renamed.md")?.error).toContain("deleted");
    add("Replacement"); expect(provider.prompt).toHaveBeenCalledTimes(1);
  });
  it("rejects unknown providers, rebinding, parent-session reuse and corrupt saved routes", async () => {
    await expect(manager.bind(room, { ...origin, provider: "unknown" })).rejects.toThrow(/Unsupported native session provider/);
    vi.mocked(provider.fork).mockResolvedValueOnce("original");
    await expect(manager.bind(room, origin)).rejects.toThrow(/did not fork/);
    expect(manager.owns("report.md")).toBe(false);
    await manager.bind(room, origin);
    await expect(manager.bind(room, origin)).rejects.toThrow(/already/);
    await manager.close(); await writeFile(join(root, ".quire/conversations", bindingFileName("report.md")), "{}");
    manager = new ArtifactConversations(vault, provider);
    await expect(manager.load()).rejects.toThrow(/Invalid|Expected/);
  });

  it("retains automatic connection failures without silently using the embedded agent", async () => {
    vi.mocked(provider.fork).mockRejectedValueOnce(new Error("Delivery still active"));
    await expect(manager.bind(room, origin, true)).rejects.toThrow("Delivery still active");
    expect(manager.status("report.md")).toMatchObject({ state: "failed", error: expect.stringContaining("Codex handoff failed") });
    expect(manager.owns("report.md")).toBe(true); expect(manager.busy("report.md")).toBe(false);
    expect(manager.connecting("report.md")).toBe(true);
    add("Queued after connection failed");
    await manager.retry("report.md"); await idle();
    expect(provider.prompt).toHaveBeenCalledTimes(1);
    expect(store.list()[0]!.replies.at(-1)!.body).toBe("Native answer");
  });

  it("disconnects a pending handoff only after its native wait stops", async () => {
    let stop!: () => void;
    vi.mocked(provider.fork).mockImplementation((_origin, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { stop = () => reject(new Error("Cancelled waiting for delivery")); });
    }));
    const connecting = manager.bind(room, origin, true);
    const checked = expect(connecting).rejects.toThrow("Cancelled waiting for delivery");
    let stopped = false;
    const disconnecting = manager.unbind("report.md").then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false); expect(manager.owns("report.md")).toBe(true);
    stop(); await checked; await disconnecting;
    expect(manager.status("report.md")).toBeNull(); expect(manager.owns("report.md")).toBe(false);
    expect(provider.prompt).not.toHaveBeenCalled();
  });
});
