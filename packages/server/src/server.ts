import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { type IncomingMessage, type Server, createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { WebSocketServer } from "ws";
import { GitSnapshotter, type GitSnapshotOptions, Vault, type VaultOptions } from "@quire/bridge";
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
    const http = createServer((req, res) => void this.onRequest(req, res));
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

      wss.handleUpgrade(req, socket, head, (ws) => this.room(path).add(ws, role));
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
