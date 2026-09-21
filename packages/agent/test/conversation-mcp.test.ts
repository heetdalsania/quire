import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ConversationMcp } from "../src/conversation-mcp.js";

const fake = vi.hoisted(() => ({ handler: null as ((req: IncomingMessage, res: ServerResponse) => void) | null, port: 12345 }));
vi.mock("node:http", async importOriginal => {
  const original = await importOriginal<typeof import("node:http")>();
  const { EventEmitter } = await import("node:events");
  return { ...original, createServer: (handler: typeof fake.handler) => {
    fake.handler = handler;
    return Object.assign(new EventEmitter(), {
      listen: (_port: number, host: string, ready: () => void) => { expect(host).toBe("127.0.0.1"); ready(); },
      address: () => ({ port: fake.port }), closeAllConnections: vi.fn(), close: (done?: () => void) => done?.(), unref: vi.fn(),
    });
  } };
});
let endpoint: ConversationMcp | undefined;
afterEach(async () => { await endpoint?.close(); endpoint = undefined; });
const tools = () => ({ definitions: [], call: vi.fn(), setModel: vi.fn(), close: vi.fn() });
async function request(headers: Record<string, string>, method = "POST", body = "{}", url = "/mcp"): Promise<number> {
  const req = Readable.from([Buffer.from(body)]);
  Object.assign(req, { headers, method, url });
  return new Promise(resolve => {
    let code = 200;
    const res = { setHeader: vi.fn(), writeHead: (status: number) => { code = status; }, end: () => resolve(code), headersSent: false };
    fake.handler!(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  });
}
it("requires a random bearer capability, matching host, and no browser Origin", async () => {
  const controller = new AbortController(); const toolset = tools();
  endpoint = await ConversationMcp.start(toolset, controller.signal);
  const first = endpoint.config.http_headers.Authorization;
  expect(first).toMatch(/^Bearer [a-f0-9]{64}$/);
  expect(await request({ host: "127.0.0.1:12345" })).toBe(403);
  expect(await request({ host: "evil.test", authorization: first })).toBe(403);
  expect(await request({ host: "127.0.0.1:12345", authorization: first, origin: "null" })).toBe(403);
  expect(await request({ host: "127.0.0.1:12345", authorization: first }, "GET")).toBe(405);
  expect(await request({ host: "127.0.0.1:12345", authorization: first }, "POST", "invalid")).toBe(400);
  await endpoint.close();
  expect(await request({ host: "127.0.0.1:12345", authorization: first })).toBe(410);
  expect(toolset.close).toHaveBeenCalledOnce();
  endpoint = await ConversationMcp.start(tools(), controller.signal);
  expect(endpoint.config.http_headers.Authorization).not.toBe(first);
  expect(await request({ host: "127.0.0.1:12345", authorization: first })).toBe(403);
});
it("revokes immediately on cancellation and refuses already-aborted startup", async () => {
  const controller = new AbortController(); const toolset = tools();
  endpoint = await ConversationMcp.start(toolset, controller.signal);
  const capability = endpoint.config.http_headers.Authorization;
  controller.abort();
  expect(await request({ host: "127.0.0.1:12345", authorization: capability })).toBe(410);
  expect(toolset.close).toHaveBeenCalledOnce();
  await expect(ConversationMcp.start(tools(), controller.signal)).rejects.toThrow();
});
