import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ConversationTools } from "./conversation-provider.js";

/** Short-lived, authenticated loopback MCP, scoped to one native comment turn. */
export class ConversationMcp {
  private readonly http: HttpServer;
  private readonly peers = new Set<Server>();
  private readonly authorization = `Bearer ${randomBytes(32).toString("hex")}`;
  private closed: Promise<void> | null = null;
  private constructor(private readonly tools: ConversationTools, private readonly signal: AbortSignal) {
    this.http = createServer((req, res) => { void this.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500); res.end();
    }); });
    this.http.requestTimeout = 15_000;
    this.http.headersTimeout = 10_000;
  }
  static async start(tools: ConversationTools, signal: AbortSignal): Promise<ConversationMcp> {
    signal.throwIfAborted();
    const endpoint = new ConversationMcp(tools, signal);
    try {
      await new Promise<void>((resolve, reject) => {
        endpoint.http.once("error", reject);
        endpoint.http.listen(0, "127.0.0.1", () => { endpoint.http.removeListener("error", reject); resolve(); });
      });
      signal.addEventListener("abort", endpoint.abort, { once: true });
      signal.throwIfAborted();
      return endpoint;
    } catch (error) { await endpoint.close(); throw error; }
  }
  get config(): { url: string; http_headers: { Authorization: string } } {
    const address = this.http.address();
    if (!address || typeof address === "string") throw new Error("Artifact tools are unavailable");
    return { url: `http://127.0.0.1:${address.port}/mcp`, http_headers: { Authorization: this.authorization } };
  }
  private readonly abort = () => { void this.close(); };
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    if (this.closed || this.signal.aborted) { res.writeHead(410); res.end(); return; }
    const expectedHost = new URL(this.config.url).host;
    const supplied = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(this.authorization);
    // Browser clients do not need access to this separate native-tool capability.
    if (req.headers.origin !== undefined || req.headers.host !== expectedHost || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(403); res.end(); return; }
    if (req.url !== "/mcp") { res.writeHead(404); res.end(); return; }
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    if (this.peers.size >= 8) { res.writeHead(429); res.end(); return; }
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 512 * 1024) { res.writeHead(413); res.end(); return; }
      chunks.push(chunk);
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { res.writeHead(400); res.end(); return; }
    if (this.closed || this.signal.aborted) { res.writeHead(410); res.end(); return; }
    const server = new Server({ name: "quire-artifact", version: "0.2.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.tools.definitions }));
    server.setRequestHandler(CallToolRequestSchema, async request => this.tools.call(request.params.name, request.params.arguments ?? {}));
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    this.peers.add(server);
    const cleanup = () => { this.peers.delete(server); void server.close(); };
    res.once("close", cleanup);
    try { await server.connect(transport as Transport); await transport.handleRequest(req, res, body); }
    catch (error) { cleanup(); throw error; }
  }
  close(): Promise<void> {
    return this.closed ??= (async () => {
      this.signal.removeEventListener("abort", this.abort);
      this.tools.close();
      await Promise.all([...this.peers].map(peer => peer.close())); this.peers.clear();
      this.http.closeAllConnections();
      await new Promise<void>(resolve => this.http.close(() => resolve()));
    })();
  }
}
