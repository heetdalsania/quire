import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { type IncomingMessage, type Server, createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { WebSocketServer } from "ws";
import {
  GitSnapshotter,
  type GitSnapshotOptions,
  Vault,
  type VaultOptions,
  buildReplay,
  knownAuthors,
  replayFrameText,
  readPolicy,
  summarise,
  writePolicy,
} from "@quire/bridge";
import { buildLinkGraph } from "./links.js";
import {
  RegistryFetchError,
  fetchEntry,
  findEntry,
  loadRegistry,
  resolveInstallPath,
  sourceUrl,
} from "./registry.js";
import { GithubSearchError, listMarkdown, searchGithub } from "./github.js";
import {
  type DriftReport,
  type LockedDocument,
  checkDrift,
  readLockfile,
  recordInstall,
  stripProvenanceHeader,
} from "./lockfile.js";
import { ExecRefused, formatResult, runBlock, supportedLanguages } from "./exec.js";
import { isRequestAllowed, isSafeDocPath } from "./security.js";
import { ShareRegistry, type ShareRole } from "./sharing.js";
import { searchDocuments, searchVault } from "./search.js";
import { Room } from "./room.js";

export interface QuireServerOptions extends VaultOptions {
  port?: number;
  host?: string;
  /** Directory containing the built web client. */
  webRoot?: string;
  /** Periodic git snapshots. Disabled when the vault is not a git repository. */
  git?: GitSnapshotOptions | false;
  /**
   * Extra hostnames permitted to reach this server, beyond loopback. Set this only when
   * deliberately exposing the vault, e.g. through a tunnel.
   */
  allowedHosts?: string[];
  /** Path to the registry index. Omit to disable Discover entirely. */
  registryPath?: string;
  /** Allow live GitHub search from Discover. */
  githubSearch?: boolean;
  /**
   * Allow running fenced code blocks. Off by default, and refused at request time when
   * the server is bound beyond loopback -- see exec.ts.
   */
  allowExec?: boolean;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

export class QuireServer {
  /** Capability links. In memory only, so they never outlive the session that made them. */
  readonly shares = new ShareRegistry();

  /** Open server-sent-event streams, used to push vault changes to connected clients. */
  private readonly eventStreams = new Set<import("node:http").ServerResponse>();
  /** A ceiling so a misbehaving client cannot open streams until the server runs out. */
  private static readonly MAX_EVENT_STREAMS = 64;
  private roomSweep: NodeJS.Timeout | null = null;

  /** Identifies this process's document lineage; see Room.add. */
  readonly epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  /** Live rooms by document path. Exposed for tests and for embedding hosts. */
  readonly rooms = new Map<string, Room>();
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;

  readonly git: GitSnapshotter | null;
  /** Whether the vault is a git repository, so the UI can hide snapshotting when it is not. */
  private gitReady = false;

  private constructor(
    readonly vault: Vault,
    private readonly opts: QuireServerOptions,
  ) {
    this.git = opts.git === false ? null : new GitSnapshotter(vault, opts.git ?? {});

    // Files created by an agent, by the registry, or by another tool used to require a
    // reload before they appeared in the sidebar -- which reads as the app being stale
    // exactly when something interesting just happened.
    for (const event of ["doc:written", "doc:open", "doc:delete", "doc:rename"]) {
      vault.on(event, () => this.publish("files"));
    }
  }

  /**
   * Release rooms nobody is in.
   *
   * A room is cheap but not free -- it holds an Awareness and a document listener -- and
   * over a long session with many documents they would otherwise accumulate for every
   * file anyone ever opened. The document itself stays in the vault, so reconnecting just
   * builds a fresh room.
   */
  private startRoomSweep(): void {
    this.roomSweep = setInterval(() => {
      for (const [path, room] of this.rooms) {
        if (room.size === 0) {
          room.destroy();
          this.rooms.delete(path);
        }
      }
    }, 60_000);
    this.roomSweep.unref?.();
  }

  private publish(kind: string): void {
    const payload = `data: ${JSON.stringify({ kind, files: this.vault.list() })}\n\n`;
    for (const stream of this.eventStreams) {
      try {
        stream.write(payload);
      } catch {
        this.eventStreams.delete(stream);
      }
    }
  }

  static async start(options: QuireServerOptions): Promise<QuireServer> {
    const vault = await Vault.open(options);
    const server = new QuireServer(vault, options);
    await server.listen();
    server.gitReady = Boolean(server.git && (await server.git.isRepo()));
    if (server.gitReady) server.git?.start();
    server.startRoomSweep();
    return server;
  }

  get port(): number {
    const address = this.http?.address();
    return typeof address === "object" && address ? address.port : 0;
  }

  /** Live contents of every document, straight from the CRDTs. */
  private documents(): Array<{ path: string; text: string }> {
    return this.vault.list().map((path) => ({ path, text: this.vault.getDoc(path).getContent() }));
  }

  private room(path: string): Room {
    let room = this.rooms.get(path);
    if (!room) {
      room = new Room(this.vault.getDoc(path), this.epoch);
      this.rooms.set(path, room);
    }
    return room;
  }

  private async listen(): Promise<void> {
    const http = createServer((req, res) => {
      // An async handler that throws becomes an unhandled rejection, and Node's default
      // is to kill the process -- so a single malformed request could end everyone's
      // session. Every request is contained, whatever the endpoint does.
      void this.onRequest(req, res).catch((error: unknown) => {
        console.error(`[quire] request failed: ${(error as Error).message}`);
        if (res.headersSent) return res.destroy();
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Request failed" }));
      });
    });
    const wss = new WebSocketServer({ noServer: true });

    http.on("upgrade", (req, socket, head) => {
      const reject = (status: string): void => {
        socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
      };

      if (!isRequestAllowed(req, { allowedHosts: this.opts.allowedHosts ?? [] })) {
        return reject("403 Forbidden");
      }

      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/sync") return reject("404 Not Found");

      const path = url.searchParams.get("doc");
      if (!path || !isSafeDocPath(path)) return reject("400 Bad Request");

      const role = this.shares.roleFor(url.searchParams.get("share"), path);
      if (role === "denied") return reject("403 Forbidden");

      const isAgent = url.searchParams.get("kind") === "agent";
      wss.handleUpgrade(req, socket, head, (ws) => this.room(path).add(ws, role, isAgent));
    });

    this.http = http;
    this.wss = wss;

    await new Promise<void>((resolve) =>
      http.listen(this.opts.port ?? 4321, this.opts.host ?? "127.0.0.1", resolve),
    );
  }

  private async onRequest(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    if (!isRequestAllowed(req, { allowedHosts: this.opts.allowedHosts ?? [] })) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Forbidden: this Quire server only answers its own origin.");
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");

    const json = (body: unknown, status = 200): void => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/api/files") {
      json({
        files: this.vault.list(),
        epoch: this.epoch,
        git: this.gitReady,
        githubSearch: Boolean(this.opts.githubSearch),
        exec: Boolean(this.opts.allowExec),
        history: this.opts.history === true,
      });
      return;
    }

    if (url.pathname === "/api/search") {
      const query = url.searchParams.get("q") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? 60);
      const viaRipgrep = await searchVault(this.vault.root, query, limit);
      if (viaRipgrep.engine === "ripgrep") {
        // Trust an empty ripgrep result. Re-scanning every document because a query
        // legitimately matched nothing turned the common case into the slow path.
        json({ results: viaRipgrep.results });
        return;
      }
      json({ results: searchDocuments(this.documents(), query, limit) });
      return;
    }

    if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      if (this.eventStreams.size >= QuireServer.MAX_EVENT_STREAMS) {
        res.end("event: error\ndata: too many event streams\n\n");
        return;
      }
      res.write(`data: ${JSON.stringify({ kind: "files", files: this.vault.list() })}\n\n`);
      this.eventStreams.add(res);
      req.on("close", () => this.eventStreams.delete(res));
      return;
    }

    if (url.pathname === "/api/registry") {
      if (!this.opts.registryPath) {
        json({ available: false, categories: [], entries: [] });
        return;
      }
      const index = await loadRegistry(this.opts.registryPath);
      json({
        available: true,
        note: index.note,
        categories: index.categories,
        entries: index.entries.map((e) => ({ ...e, source: sourceUrl(e) })),
      });
      return;
    }

    if (url.pathname === "/api/registry/preview") {
      const entry = this.opts.registryPath
        ? findEntry(await loadRegistry(this.opts.registryPath), url.searchParams.get("id") ?? "")
        : null;
      if (!entry) return json({ error: "Unknown registry entry" }, 404);
      try {
        json({ content: await fetchEntry(entry), source: sourceUrl(entry) });
      } catch (error) {
        json({ error: (error as RegistryFetchError).message }, 502);
      }
      return;
    }

    if (url.pathname === "/api/registry/install" && req.method === "POST") {
      const entry = this.opts.registryPath
        ? findEntry(await loadRegistry(this.opts.registryPath), url.searchParams.get("id") ?? "")
        : null;
      if (!entry) return json({ error: "Unknown registry entry" }, 404);

      const target = resolveInstallPath(entry, url.searchParams.get("as") ?? undefined);
      if (!target) return json({ error: "Unsafe install path" }, 400);
      if (this.vault.list().includes(target)) {
        return json({ error: `${target} already exists in this vault` }, 409);
      }

      try {
        const content = await fetchEntry(entry);
        // Write through the vault so the document is a live CRDT immediately, rather
        // than a file that only becomes collaborative after the watcher notices it.
        const handle = this.vault.getDoc(target);
        handle.doc.transact(() => handle.text.insert(0, attribute(entry, content)));
        await this.vault.flush();
        // Remember what upstream looked like, so drift can be told from local editing.
        await recordInstall(this.vault.root, entry, target, content);
        json({ path: target });
      } catch (error) {
        json({ error: (error as RegistryFetchError).message }, 502);
      }
      return;
    }

    if (url.pathname === "/api/share" && req.method === "POST") {
      const role = (url.searchParams.get("role") ?? "view") as ShareRole;
      if (!["view", "comment", "edit"].includes(role)) return json({ error: "Unknown role" }, 400);

      const path = url.searchParams.get("path");
      if (path && !isSafeDocPath(path)) return json({ error: "Unsafe path" }, 400);

      const hours = Number(url.searchParams.get("hours") ?? 0);
      if (!Number.isFinite(hours) || hours < 0) {
        return json({ error: "hours must be zero (no expiry) or positive" }, 400);
      }
      const share = this.shares.create({
        role,
        path: path ?? null,
        ttlMs: hours > 0 ? hours * 3_600_000 : null,
        label: path ?? "whole vault",
      });
      json({ token: share.token, role: share.role, path: share.path, expiresAt: share.expiresAt });
      return;
    }

    if (url.pathname === "/api/share" && req.method === "GET") {
      json({ shares: this.shares.list() });
      return;
    }

    if (url.pathname === "/api/share" && req.method === "DELETE") {
      json({ revoked: this.shares.revoke(url.searchParams.get("token") ?? "") });
      return;
    }

    if (url.pathname === "/api/discover/search") {
      if (!this.opts.githubSearch) return json({ hits: [], available: false });
      try {
        json({ hits: await searchGithub(url.searchParams.get("q") ?? ""), available: true });
      } catch (error) {
        json({ error: (error as GithubSearchError).message, available: true }, 503);
      }
      return;
    }

    if (url.pathname === "/api/discover/files") {
      if (!this.opts.githubSearch) return json({ files: [] });
      try {
        json({
          files: await listMarkdown(
            url.searchParams.get("repo") ?? "",
            url.searchParams.get("branch") ?? "main",
          ),
        });
      } catch (error) {
        json({ error: (error as GithubSearchError).message }, 503);
      }
      return;
    }

    if (url.pathname === "/api/discover/install" && req.method === "POST") {
      const repo = url.searchParams.get("repo") ?? "";
      const branch = url.searchParams.get("branch") ?? "main";
      const path = url.searchParams.get("path") ?? "";
      const target = url.searchParams.get("as") ?? (path.split("/").pop() ?? "");

      if (!this.opts.githubSearch) return json({ error: "GitHub search is disabled" }, 403);
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: "Bad repository" }, 400);
      if (!isSafeDocPath(target) || !/\.(md|markdown)$/i.test(target)) {
        return json({ error: "Unsafe install path" }, 400);
      }
      if (this.vault.list().includes(target)) return json({ error: `${target} already exists` }, 409);

      const entry = {
        id: `gh:${repo}`, title: target, byline: repo.split("/")[0] ?? "",
        description: "", category: "", repo, branch, path,
        installAs: target, license: "See repository", stars: 0,
      };
      try {
        const content = await fetchEntry(entry);
        const handle = this.vault.getDoc(target);
        handle.doc.transact(() => handle.text.insert(0, attribute(entry, content)));
        await this.vault.flush();
        json({ path: target });
      } catch (error) {
        json({ error: (error as Error).message }, 502);
      }
      return;
    }

    if (url.pathname === "/api/replay") {
      const path = url.searchParams.get("doc") ?? "";
      if (!isSafeDocPath(path)) return json({ error: "Unsafe path" }, 400);
      if (this.opts.history !== true) {
        return json(
          {
            error:
              "Replay needs edit history, which is off by default because retaining it " +
              "makes document state grow without bound. Restart with --history to enable it.",
          },
          409,
        );
      }
      const handle = this.vault.getDoc(path);
      // Metadata only. Frame text is fetched one at a time, because shipping every
      // frame's full text scales with document size multiplied by frame count.
      json({
        frames: buildReplay(handle.doc, "content", {
          frames: Math.min(Number(url.searchParams.get("frames") ?? 48), 160),
        }),
        authors: knownAuthors(handle.doc),
      });
      return;
    }

    if (url.pathname === "/api/replay/frame") {
      const path = url.searchParams.get("doc") ?? "";
      if (!isSafeDocPath(path)) return json({ error: "Unsafe path" }, 400);
      const at = Number(url.searchParams.get("at") ?? 1);
      if (!Number.isFinite(at)) return json({ error: "at must be a number" }, 400);
      json({ text: replayFrameText(this.vault.getDoc(path).doc, at) });
      return;
    }

    if (url.pathname === "/api/provenance") {
      const path = url.searchParams.get("doc") ?? "";
      if (!isSafeDocPath(path)) return json({ error: "Unsafe path" }, 400);
      const handle = this.vault.getDoc(path);
      const authors = knownAuthors(handle.doc);
      json({
        summary: summarise(handle.doc, handle.text, authors as never),
        policy: readPolicy(handle.doc),
      });
      return;
    }

    if (url.pathname === "/api/policy" && req.method === "POST") {
      const path = url.searchParams.get("doc") ?? "";
      if (!isSafeDocPath(path)) return json({ error: "Unsafe path" }, 400);
      const handle = this.vault.getDoc(path);
      const mode = url.searchParams.get("mode");
      const locked = url.searchParams.get("locked");
      json({
        policy: writePolicy(handle.doc, {
          ...(mode ? { mode: mode as "edit" | "propose" | "read-only" } : {}),
          ...(locked !== null ? { lockedSections: locked ? locked.split("|") : [] } : {}),
        }),
      });
      return;
    }

    if (url.pathname === "/api/drift") {
      if (!this.opts.registryPath) return json({ documents: [] });
      const index = await loadRegistry(this.opts.registryPath);
      const lock = await readLockfile(this.vault.root);
      const entryFor = (locked: LockedDocument) => ({
        id: locked.path, title: locked.title, byline: locked.repo.split("/")[0] ?? "",
        description: "", category: "", repo: locked.repo, branch: locked.branch,
        path: locked.sourcePath, installAs: locked.path, license: locked.license, stars: 0,
      });
      const reports = await Promise.all(
        Object.values(lock.documents).map(async (locked): Promise<DriftReport> => {
          // A lockfile ships inside a vault, so it can arrive from an untrusted
          // repository. One malformed or hostile entry must not take out the listing.
          if (!isSafeDocPath(locked.path)) {
            return {
              path: locked.path, title: locked.title, repo: locked.repo,
              state: "unknown", detail: "Ignored: path escapes the vault.",
            };
          }
          return checkDrift(
            (l) => fetchEntry(entryFor(l)),
            locked,
            this.vault.getDoc(locked.path).getContent(),
          );
        }),
      );
      json({ documents: reports.map(({ upstreamText, ...rest }) => rest), indexed: index.entries.length });
      return;
    }

    if (url.pathname === "/api/drift/update" && req.method === "POST") {
      const path = url.searchParams.get("doc") ?? "";
      const lock = await readLockfile(this.vault.root);
      const locked = lock.documents[path];
      if (!locked) return json({ error: `${path} is not a tracked document` }, 404);
      if (!isSafeDocPath(locked.path) || !isSafeDocPath(path)) {
        return json({ error: "Refusing a lockfile path that escapes the vault" }, 400);
      }

      const entryFor = (l: LockedDocument) => ({
        id: l.path, title: l.title, byline: "", description: "", category: "",
        repo: l.repo, branch: l.branch, path: l.sourcePath, installAs: l.path,
        license: l.license, stars: 0,
      });
      const report = await checkDrift((l) => fetchEntry(entryFor(l)), locked, this.vault.getDoc(path).getContent());
      if (!report.upstreamText) return json({ error: report.detail }, 502);

      // Apply upstream as a CRDT delta, exactly as an external edit would arrive, so any
      // local changes outside the changed region survive.
      const handle = this.vault.getDoc(path);
      handle.applyFromDisk(attribute(entryFor(locked), report.upstreamText));
      await this.vault.flush();
      await recordInstall(this.vault.root, entryFor(locked), path, report.upstreamText);
      json({ path, state: report.state });
      return;
    }

    if (url.pathname === "/api/exec" && req.method === "POST") {
      const host = this.opts.host ?? "127.0.0.1";
      const exposed = !["127.0.0.1", "localhost", "::1"].includes(host);
      let parsed: { language?: string; source?: string; path?: string };
      try {
        parsed = JSON.parse((await readBody(req)) || "{}") as typeof parsed;
      } catch {
        return json({ error: "Body must be JSON" }, 400);
      }
      const { language, source, path } = parsed;
      if (typeof language !== "string" || typeof source !== "string" || !language || !source) {
        return json({ error: "language and source are required, as strings" }, 400);
      }

      try {
        const result = await runBlock(language, source, {
          enabled: Boolean(this.opts.allowExec),
          exposed,
          cwd: this.vault.root,
        });
        // Log every execution. A feature that runs arbitrary code should never do so
        // quietly.
        console.log(
          `[quire] ran ${language} block from ${path ?? "(unknown)"} -> ${result.exitCode === 0 ? "ok" : `exit ${result.exitCode}`} in ${result.durationMs}ms`,
        );
        json({ result, markdown: formatResult(result) });
      } catch (error) {
        json(
          {
            error: (error as ExecRefused).message,
            supported: supportedLanguages(),
          },
          error instanceof ExecRefused ? 403 : 500,
        );
      }
      return;
    }

    if (url.pathname === "/api/links") {
      json(buildLinkGraph(this.documents()));
      return;
    }

    if (url.pathname === "/api/history") {
      json({ commits: (await this.git?.history(40)) ?? [] });
      return;
    }

    if (url.pathname === "/api/snapshot" && req.method === "POST") {
      const sha = await this.git?.commit();
      json({ sha: sha ?? null });
      return;
    }

    const webRoot = this.opts.webRoot;
    if (!webRoot) {
      res.writeHead(404).end("web client not built");
      return;
    }

    // Serve the SPA, falling back to index.html. normalize() prevents path escape.
    const requested = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
    let file = join(webRoot, requested === "/" ? "index.html" : requested);
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    } catch {
      file = join(webRoot, "index.html");
    }
    if (!file.startsWith(webRoot)) {
      res.writeHead(403).end("forbidden");
      return;
    }

    try {
      await stat(file);
    } catch {
      res.writeHead(404).end("not found");
      return;
    }

    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  }

  async close(): Promise<void> {
    if (this.roomSweep) clearInterval(this.roomSweep);
    this.roomSweep = null;
    for (const stream of this.eventStreams) stream.end();
    this.eventStreams.clear();
    this.git?.stop();
    for (const room of this.rooms.values()) room.destroy();
    this.rooms.clear();
    this.wss?.close();
    await new Promise<void>((resolve) => {
      if (!this.http) return resolve();
      this.http.close(() => resolve());
    });
    await this.vault.close();
  }
}

/**
 * Prepend provenance to an installed document.
 *
 * Someone reading this file in six months should be able to tell where it came from and
 * under what terms, without going back to whoever installed it.
 */
function attribute(
  entry: { title: string; byline: string; repo: string; license: string },
  content: string,
): string {
  const header =
    `<!-- Installed by Quire from ${entry.repo} (${entry.license}). ` +
    `"${entry.title}" by ${entry.byline}. Source: https://github.com/${entry.repo} -->\n\n`;
  return header + content;
}

/** Read a request body with a hard ceiling, so a stream cannot exhaust memory. */
async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
