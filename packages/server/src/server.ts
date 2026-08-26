import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { type IncomingMessage, type Server, createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { WebSocketServer } from "ws";
import { GitSnapshotter, type GitSnapshotOptions, Vault, type VaultOptions } from "@quire/bridge";
import { buildLinkGraph } from "./links.js";
import { isRequestAllowed, isSafeDocPath } from "./security.js";
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
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

export class QuireServer {
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

      wss.handleUpgrade(req, socket, head, (ws) => this.room(path).add(ws));
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
      json({ files: this.vault.list(), epoch: this.epoch, git: this.gitReady });
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
