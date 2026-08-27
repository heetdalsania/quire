import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildReplay, insertAttributed, type Author } from "@quire/bridge";
import { QuireServer } from "../src/index.js";
import { ExecRefused, formatResult, runBlock, supportedLanguages } from "../src/exec.js";
import { checkDrift, hashText, readLockfile, recordInstall, stripProvenanceHeader } from "../src/lockfile.js";

const agent: Author = { id: "a1", name: "Claude", color: "#ea9d34", kind: "agent" };
const human: Author = { id: "h1", name: "Heet", color: "#907aa9", kind: "human" };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "quire-feat-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("executable documents", () => {
  const base = { exposed: false, cwd: "/tmp" };

  it("refuses when not explicitly enabled", async () => {
    await expect(runBlock("bash", "echo hi", { ...base, enabled: false })).rejects.toThrow(ExecRefused);
  });

  it("refuses whenever the server is reachable beyond localhost", async () => {
    // Quire has no authentication, so an exposed server with execution enabled would hand
    // a shell to anyone who could reach the port.
    await expect(runBlock("bash", "echo hi", { ...base, enabled: true, exposed: true })).rejects.toThrow(
      /beyond localhost/,
    );
  });

  it("refuses a language it has no runner for", async () => {
    await expect(runBlock("ruby", "puts 1", { ...base, enabled: true })).rejects.toThrow(/No runner/);
    expect(supportedLanguages()).toContain("bash");
    expect(supportedLanguages()).not.toContain("ruby");
  });

  it("runs a block and captures its output", async () => {
    const result = await runBlock("bash", "echo captured", { ...base, enabled: true, cwd: dir });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("captured");
  });

  it("runs in the vault directory", async () => {
    const result = await runBlock("bash", "pwd", { ...base, enabled: true, cwd: dir });
    expect(result.stdout).toContain(dir.replace("/private", ""));
  });

  it("reports a failing block rather than throwing", async () => {
    const result = await runBlock("bash", "exit 3", { ...base, enabled: true, cwd: dir });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
  });

  it("kills a block that overruns its timeout", async () => {
    const result = await runBlock("bash", "sleep 10", {
      ...base, enabled: true, cwd: dir, timeoutMs: 400,
    });
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("killed after");
  }, 15_000);

  it("caps runaway output", async () => {
    const result = await runBlock("bash", "yes abcdefgh | head -c 200000", {
      ...base, enabled: true, cwd: dir, maxOutputBytes: 2048,
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(2048);
  }, 15_000);

  it("formats output as a Markdown block with a status stamp", () => {
    const markdown = formatResult({
      ok: true, language: "bash", stdout: "hello", stderr: "",
      exitCode: 0, durationMs: 12, truncated: false,
    });
    expect(markdown).toContain("```text");
    expect(markdown).toContain("hello");
    expect(markdown).toContain("quire:output");
  });
});

describe("upstream drift", () => {
  const entry = {
    id: "x", title: "Karpathy CLAUDE.md", byline: "multica-ai", description: "", category: "",
    repo: "multica-ai/andrej-karpathy-skills", branch: "main", path: "CLAUDE.md",
    installAs: "CLAUDE.md", license: "Unspecified", stars: 1,
  };


  it("records an install so drift can be measured later", async () => {
    await recordInstall(dir, entry, "CLAUDE.md", "upstream body");
    const lock = await readLockfile(dir);
    expect(lock.documents["CLAUDE.md"]?.repo).toBe("multica-ai/andrej-karpathy-skills");
    expect(lock.documents["CLAUDE.md"]?.installedHash).toBe(hashText("upstream body"));
    // Written as plain JSON so it is reviewable in a diff, like any other lockfile.
    expect(await readFile(join(dir, "quire.lock"), "utf8")).toContain("andrej-karpathy-skills");
  });

  it("ignores the provenance header Quire wrote itself", () => {
    const withHeader = '<!-- Installed by Quire from a/b (MIT). "T" by a. Source: x -->\n\n# Body\n';
    expect(stripProvenanceHeader(withHeader)).toBe("# Body\n");
    // Otherwise every installed document would register as locally edited immediately.
    expect(hashText(stripProvenanceHeader(withHeader))).toBe(hashText("# Body\n"));
  });

  it("tells local edits, upstream changes and divergence apart", async () => {
    const locked = {
      path: "CLAUDE.md", repo: "a/b", branch: "main", sourcePath: "CLAUDE.md",
      installedHash: hashText("original"), installedAt: "", license: "MIT", title: "T",
    };
    const upstream = (text: string) => async () => text;

    // The distinction that matters: knowing *which* side moved decides whether updating
    // is a clean replace or a merge.
    expect((await checkDrift(upstream("original"), locked, "original")).state).toBe("current");
    expect((await checkDrift(upstream("moved on"), locked, "original")).state).toBe("upstream-changed");
    expect((await checkDrift(upstream("original"), locked, "my edits")).state).toBe("locally-edited");
    expect((await checkDrift(upstream("moved on"), locked, "my edits")).state).toBe("diverged");
  });

  it("reports unreachable upstreams as unknown rather than as unchanged", async () => {
    const locked = {
      path: "CLAUDE.md", repo: "a/b", branch: "main", sourcePath: "CLAUDE.md",
      installedHash: hashText("original"), installedAt: "", license: "MIT", title: "T",
    };
    const report = await checkDrift(
      async () => { throw new Error("offline"); },
      locked,
      "original",
    );
    // Claiming "up to date" because the network failed would be the dangerous answer.
    expect(report.state).toBe("unknown");
    expect(report.detail).toContain("offline");
  });
});

describe("replay", () => {
  it("produces frames showing a document taking shape", () => {
    // gc:false is what keeps deleted content available to replay.
    const doc = new Y.Doc({ gc: false });
    const text = doc.getText("content");
    insertAttributed(text, 0, "First sentence. ", human);
    insertAttributed(text, text.length, "Second sentence. ", agent);
    insertAttributed(text, text.length, "Third sentence.", human);

    const frames = buildReplay(doc, "content", { frames: 12 });
    expect(frames.length).toBeGreaterThan(1);
    // The last frame is always the live document.
    expect(frames[frames.length - 1]!.text).toBe(text.toString());
    expect(frames[frames.length - 1]!.at).toBe(1);
    // And it grows rather than shrinking.
    expect(frames[0]!.totalChars).toBeLessThanOrEqual(frames[frames.length - 1]!.totalChars);
  });

  it("attributes each frame", () => {
    const doc = new Y.Doc({ gc: false });
    const text = doc.getText("content");
    insertAttributed(text, 0, "human words", human);
    insertAttributed(text, text.length, " agent words", agent);
    const final = buildReplay(doc, "content", { frames: 6 }).at(-1)!;
    expect(final.byAuthor[human.id]).toBe("human words".length);
    expect(final.byAuthor[agent.id]).toBe(" agent words".length);
  });

  it("handles an empty document without throwing", () => {
    expect(buildReplay(new Y.Doc({ gc: false }))).toHaveLength(1);
  });
});

describe("exec endpoint", () => {
  it("is advertised as disabled by default", async () => {
    await writeFile(join(dir, "a.md"), "# A\n", "utf8");
    const server = await QuireServer.start({ root: dir, port: 0, git: false });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/files`);
    const body = (await res.json()) as { exec: boolean };
    expect(body.exec).toBe(false);

    const attempt = await fetch(`http://127.0.0.1:${server.port}/api/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language: "bash", source: "echo nope" }),
    });
    expect(attempt.status).toBe(403);
    await server.close();
  });
});
