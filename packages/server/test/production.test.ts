import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QuireServer } from "../src/index.js";

/**
 * Production readiness.
 *
 * Every case here failed at least once against a build that looked finished. They are
 * pinned so a future change has to break them deliberately.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let server: QuireServer;
let base: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "quire-prod-"));
  await writeFile(join(dir, "a.md"), "# Doc\n\n## Secret\n\nsensitive\n", "utf8");
  server = await QuireServer.start({ root: dir, port: 0, git: false, allowExec: true });
  base = `http://127.0.0.1:${server.port}`;
});
afterEach(async () => {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

const post = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { method: "POST", ...init });

describe("the server survives hostile input", () => {
  const bodies: Array<[string, string]> = [
    ["malformed JSON", "not json{{{"],
    ["empty body", ""],
    ["a bare array", "[1,2,3]"],
    ["null fields", '{"language":null,"source":null}'],
    ["wrong types", '{"language":42,"source":{"a":1}}'],
    ["deeply nested", `{"language":${"[".repeat(200)}${"]".repeat(200)},"source":"x"}`],
  ];

  for (const [label, body] of bodies) {
    it(`answers ${label} with 400 rather than dying`, async () => {
      // An async handler that throws becomes an unhandled rejection, and Node's default
      // is to kill the process -- one malformed request used to end everyone's session.
      const res = await post("/api/exec", {
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);

      // Still serving afterwards, which is the whole point.
      expect((await fetch(`${base}/api/files`)).ok).toBe(true);
    });
  }

  it("rejects an oversized request body without dying", async () => {
    const res = await post("/api/exec", {
      headers: { "content-type": "application/json" },
      body: "x".repeat(2_000_000),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await fetch(`${base}/api/files`)).ok).toBe(true);
  });
});

describe("cross-origin writes are refused", () => {
  const evil = { Origin: "https://evil.example" };

  it("refuses execution from another origin", async () => {
    const res = await post("/api/exec", {
      headers: { ...evil, "content-type": "application/json" },
      body: JSON.stringify({ language: "bash", source: "echo pwn" }),
    });
    expect(res.status).toBe(403);
  });

  for (const [label, path] of [
    ["share creation", "/api/share?role=edit"],
    ["policy changes", "/api/policy?doc=a.md&mode=read-only"],
    ["snapshots", "/api/snapshot"],
  ] as const) {
    it(`refuses ${label} from another origin`, async () => {
      expect((await post(path, { headers: evil })).status).toBe(403);
    });
  }

  it("refuses reads from another origin too", async () => {
    // A cross-origin GET is *sent* without CORS approval; only the response is withheld.
    // Refusing it outright is what stops a hostile page enumerating the vault.
    expect((await fetch(`${base}/api/files`, { headers: evil })).status).toBe(403);
  });
});

describe("no endpoint writes outside the vault", () => {
  const escapes = ["../../../etc/passwd", "/etc/passwd", "..%2f..%2fetc%2fpasswd", "a/../../b.md"];

  for (const attempt of escapes) {
    it(`refuses "${attempt}" on replay and provenance`, async () => {
      const q = encodeURIComponent(attempt);
      expect((await fetch(`${base}/api/replay?doc=${q}`)).status).toBeGreaterThanOrEqual(400);
      expect((await fetch(`${base}/api/provenance?doc=${q}`)).status).toBeGreaterThanOrEqual(400);
    });
  }

  it("refuses an install target that escapes, or that is not Markdown", async () => {
    for (const target of ["../../escaped.md", "/tmp/escaped.md", "passwd", "a/../../b.md"]) {
      const res = await post(`/api/registry/install?id=x&as=${encodeURIComponent(target)}`);
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });

  it("ignores a lockfile entry whose path escapes the vault", async () => {
    // A lockfile travels inside a vault, so it can arrive from an untrusted repository.
    await writeFile(
      join(dir, "quire.lock"),
      JSON.stringify({
        version: 1,
        documents: {
          "../../../tmp/pwned.md": {
            path: "../../../tmp/pwned.md", repo: "a/b", branch: "main",
            sourcePath: "README.md", installedHash: "x", installedAt: "",
            license: "MIT", title: "T",
          },
        },
      }),
      "utf8",
    );
    await sleep(300);

    const res = await post("/api/drift/update?doc=../../../tmp/pwned.md");
    expect(res.status).toBeGreaterThanOrEqual(400);
    await expect(readFile("/tmp/pwned.md", "utf8")).rejects.toThrow();
  });
});

describe("resources stay bounded", () => {
  it("does not ship every replay frame's text", async () => {
    const big = `# Big\n\n${"lorem ipsum dolor sit amet. ".repeat(20_000)}`;
    await writeFile(join(dir, "big.md"), big, "utf8");
    await sleep(700);

    const res = await fetch(`${base}/api/replay?doc=big.md&frames=160`);
    const body = await res.text();
    // This response was 90 MB before frame text became a separate request.
    expect(body.length).toBeLessThan(200_000);
  }, 30_000);

  it("refuses replay entirely when history is off", async () => {
    // The default. Retaining history makes state grow with edit volume, not doc size.
    const res = await fetch(`${base}/api/replay?doc=a.md`);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("--history");
  });

  it("validates share expiry rather than silently never expiring", async () => {
    for (const hours of ["-99", "abc", "-0.5"]) {
      expect((await post(`/api/share?role=view&hours=${hours}`)).status).toBe(400);
    }
    expect((await post("/api/share?role=view&hours=1")).ok).toBe(true);
  });

  it("refuses an unknown share role", async () => {
    expect((await post("/api/share?role=admin")).status).toBe(400);
  });

  it("survives a very long search query", async () => {
    const res = await fetch(`${base}/api/search?q=${"x".repeat(10_000)}`);
    expect(res.ok).toBe(true);
  });
});

describe("execution stays contained", () => {
  it("runs only in the vault directory", async () => {
    const res = await post("/api/exec", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language: "bash", source: "pwd" }),
    });
    const body = (await res.json()) as { result: { stdout: string } };
    expect(body.result.stdout).toContain(dir.replace("/private", ""));
  });

  it("refuses an interpreter it does not know", async () => {
    const res = await post("/api/exec", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language: "ruby", source: "puts 1" }),
    });
    expect(res.status).toBe(403);
  });
});
