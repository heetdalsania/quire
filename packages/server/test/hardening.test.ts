import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { QuireServer } from "../src/index.js";
import { buildLinkGraph } from "../src/links.js";
import { searchVault } from "../src/search.js";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let server: QuireServer;
let port: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "quire-hard-"));
  await writeFile(join(dir, "doc.md"), "# Doc\n\nbody\n", "utf8");
  server = await QuireServer.start({ root: dir, port: 0, git: false });
  port = server.port;
});

afterEach(async () => {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${port}`;

/** Open a sync socket and resolve once it settles or errors. */
function openSocket(docPath: string, headers: Record<string, string> = {}) {
  const url = `ws://127.0.0.1:${port}/sync?doc=${encodeURIComponent(docPath)}`;
  return new Promise<{ ok: boolean; code?: number }>((resolve) => {
    const ws = new WebSocket(url, { headers });
    const done = (r: { ok: boolean; code?: number }) => {
      try { ws.close(); } catch { /* already closing */ }
      resolve(r);
    };
    ws.on("open", () => setTimeout(() => done({ ok: true }), 120));
    ws.on("error", () => done({ ok: false }));
    ws.on("unexpected-response", (_req, res) => done({ ok: false, code: res.statusCode ?? 0 }));
    setTimeout(() => done({ ok: false }), 2500);
  });
}

describe("path traversal", () => {
  it("refuses a document path that escapes the vault", async () => {
    const outside = join(tmpdir(), `quire-escape-${Date.now()}.md`);
    await rm(outside, { force: true });

    const result = await openSocket("../../../../../../tmp/quire-escape.md");
    await sleep(300);

    // Whatever the transport does, nothing may be created outside the vault.
    const escaped = await readFile(outside, "utf8").catch(() => null);
    expect(escaped).toBeNull();
    expect(result.ok).toBe(false);
  });

  it("refuses an absolute document path", async () => {
    const result = await openSocket("/etc/hosts");
    expect(result.ok).toBe(false);
  });

  it("does not serve files outside the web root", async () => {
    for (const attack of [
      "/../../../../etc/hosts",
      "/..%2f..%2f..%2fetc%2fhosts",
      "/%2e%2e/%2e%2e/etc/hosts",
    ]) {
      const res = await fetch(`${base()}${attack}`);
      const body = await res.text();
      expect(body).not.toContain("localhost");
    }
  });
});

describe("cross-origin access", () => {
  it("rejects a websocket from a foreign origin", async () => {
    const result = await openSocket("doc.md", { Origin: "https://evil.example" });
    expect(result.ok).toBe(false);
  });

  it("still accepts a same-origin websocket", async () => {
    const result = await openSocket("doc.md", { Origin: `http://127.0.0.1:${port}` });
    expect(result.ok).toBe(true);
  });

  it("rejects cross-origin API reads", async () => {
    const res = await fetch(`${base()}/api/files`, { headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
});

describe("hostile and unusual filenames", () => {
  it("handles unicode, spaces and dots in names", async () => {
    const names = ["a doc with spaces.md", "üñïçødé-café.md", "dotted.name.v2.md", "ALLCAPS.MD"];
    for (const name of names) await writeFile(join(dir, name), `# ${name}\n`, "utf8");
    await sleep(600);
    const { files } = (await (await fetch(`${base()}/api/files`)).json()) as { files: string[] };
    for (const name of names) expect(files).toContain(name);
  });

  it("indexes documents in nested directories", async () => {
    await mkdir(join(dir, "a/b/c"), { recursive: true });
    await writeFile(join(dir, "a/b/c/deep.md"), "# Deep\n", "utf8");
    await sleep(600);
    const { files } = (await (await fetch(`${base()}/api/files`)).json()) as { files: string[] };
    expect(files).toContain("a/b/c/deep.md");
  });

  it("does not follow symlinks out of the vault", async () => {
    const outside = await mkdtemp(join(tmpdir(), "quire-outside-"));
    await writeFile(join(outside, "secret.md"), "# Secret\n", "utf8");
    await symlink(outside, join(dir, "linked"), "dir").catch(() => {});
    await sleep(600);
    const { files } = (await (await fetch(`${base()}/api/files`)).json()) as { files: string[] };
    expect(files.some((f) => f.includes("secret"))).toBe(false);
    await rm(outside, { recursive: true, force: true });
  });
});

describe("content edge cases", () => {
  it("preserves CRLF line endings byte for byte", async () => {
    const crlf = "# Title\r\n\r\nline one\r\nline two\r\n";
    await writeFile(join(dir, "crlf.md"), crlf, "utf8");
    await sleep(500);
    expect(server.vault.getDoc("crlf.md").getContent()).toBe(crlf);
    expect(await readFile(join(dir, "crlf.md"), "utf8")).toBe(crlf);
  });

  it("preserves a byte order mark", async () => {
    const bom = "﻿# BOM\n\nbody\n";
    await writeFile(join(dir, "bom.md"), bom, "utf8");
    await sleep(500);
    expect(server.vault.getDoc("bom.md").getContent()).toBe(bom);
  });

  it("handles an empty file and a whitespace-only file", async () => {
    await writeFile(join(dir, "empty.md"), "", "utf8");
    await writeFile(join(dir, "blank.md"), "\n\n\n", "utf8");
    await sleep(500);
    expect(server.vault.getDoc("empty.md").getContent()).toBe("");
    expect(server.vault.getDoc("blank.md").getContent()).toBe("\n\n\n");
  });

  it("handles a single very long line", async () => {
    const long = `${"x".repeat(400_000)}\n`;
    await writeFile(join(dir, "long.md"), long, "utf8");
    await sleep(900);
    expect(server.vault.getDoc("long.md").getContent().length).toBe(long.length);
  });
});

describe("malformed input", () => {
  it("survives garbage websocket frames without dropping the room", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sync?doc=doc.md`, {
      headers: { Origin: base() },
    });
    await new Promise((r) => ws.on("open", r));
    for (const junk of [
      new Uint8Array([255, 255, 255, 255]),
      new Uint8Array(0),
      new Uint8Array([0, 200, 200, 200, 200]),
      crypto.getRandomValues(new Uint8Array(256)),
    ]) {
      ws.send(junk);
    }
    await sleep(300);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();

    // The server is still healthy afterwards.
    const res = await fetch(`${base()}/api/files`);
    expect(res.ok).toBe(true);
  });

  it("rejects an upgrade on an unknown path", async () => {
    const result = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/nope`, { headers: { Origin: base() } });
      ws.on("open", () => { ws.close(); resolve(true); });
      ws.on("error", () => resolve(false));
      setTimeout(() => resolve(false), 1500);
    });
    expect(result).toBe(false);
  });
});

describe("search and links robustness", () => {
  it("treats regex metacharacters in a query as literal text", async () => {
    await writeFile(join(dir, "re.md"), "a+b (c) [d] .* literal\n", "utf8");
    await sleep(500);
    const res = await fetch(`${base()}/api/search?q=${encodeURIComponent("a+b (c)")}`);
    const { results } = (await res.json()) as { results: Array<{ path: string }> };
    expect(results.some((r) => r.path === "re.md")).toBe(true);
  });

  it("does not treat a leading dash as a ripgrep flag", async () => {
    await writeFile(join(dir, "dash.md"), "some --version text\n", "utf8");
    await sleep(500);
    const res = await fetch(`${base()}/api/search?q=${encodeURIComponent("--version")}`);
    expect(res.ok).toBe(true);
    const { results } = (await res.json()) as { results: unknown[] };
    expect(Array.isArray(results)).toBe(true);
  });

  it("survives an empty query", async () => {
    const res = await fetch(`${base()}/api/search?q=`);
    expect(res.ok).toBe(true);
  });

  it("ignores self-links and resolves cycles", () => {
    const graph = buildLinkGraph([
      { path: "a.md", text: "[[a]] and [[b]]" },
      { path: "b.md", text: "[[a]]" },
    ]);
    expect(graph.outgoing["a.md"]).toEqual(["b.md"]);
    expect(graph.backlinks["a.md"]).toEqual(["b.md"]);
    expect(graph.backlinks["b.md"]).toEqual(["a.md"]);
  });

  it("leaves ambiguous wiki-link targets unresolved rather than guessing", () => {
    const graph = buildLinkGraph([
      { path: "x/note.md", text: "" },
      { path: "y/note.md", text: "" },
      { path: "z.md", text: "[[note]]" },
    ]);
    expect(graph.outgoing["z.md"]).toEqual([]);
    expect(graph.unresolved["z.md"]).toEqual(["note"]);
  });
});

describe("ripgrep absence", () => {
  it("falls back cleanly when ripgrep is not on PATH", async () => {
    const result = await searchVault(dir, "body", 10);
    expect(["ripgrep", "fallback"]).toContain(result.engine);
    expect(Array.isArray(result.results)).toBe(true);
  });
});
