import type { IncomingMessage } from "node:http";

/**
 * A Quire server is reachable at a predictable loopback address, which makes it a target
 * for drive-by attacks from any page the user happens to have open: browsers allow
 * cross-origin WebSocket connections with no preflight, and a plain GET to /api/files
 * needs no CORS approval to be *sent*. Without these checks, visiting a hostile page
 * while Quire is running would expose -- and let it rewrite -- every document.
 *
 * The rule: browsers always send Origin on WebSocket upgrades and on cross-origin
 * fetches, so a *present* Origin must be one we recognise. A *missing* Origin means a
 * non-browser client (the CLI, the MCP agent, curl), which is not a drive-by vector.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

const hostnameOf = (value: string): string => {
  const bare = value.replace(/^\[/, "[").trim();
  const lastColon = bare.lastIndexOf(":");
  const looksIpv6 = bare.startsWith("[");
  if (looksIpv6) return bare.slice(0, bare.indexOf("]") + 1).toLowerCase();
  return (lastColon === -1 ? bare : bare.slice(0, lastColon)).toLowerCase();
};

export interface OriginPolicy {
  /** Extra hostnames to trust, e.g. a tunnel domain the user chose to expose. */
  allowedHosts?: string[];
}

function isTrustedHostname(hostname: string, policy: OriginPolicy): boolean {
  if (LOOPBACK.has(hostname)) return true;
  return (policy.allowedHosts ?? []).some((h) => h.toLowerCase() === hostname);
}

/** True when this request may touch the vault. */
export function isRequestAllowed(req: IncomingMessage, policy: OriginPolicy = {}): boolean {
  // Guard against DNS rebinding: a hostile name resolving to 127.0.0.1 still arrives
  // carrying its own Host header.
  const host = req.headers.host;
  if (host && !isTrustedHostname(hostnameOf(host), policy)) return false;

  const origin = req.headers.origin;
  if (!origin) return true; // Not a browser; not a drive-by.
  if (origin === "null") return false; // Sandboxed iframe or file:// page.

  try {
    return isTrustedHostname(new URL(origin).hostname.toLowerCase(), policy);
  } catch {
    return false;
  }
}

/**
 * Validate a vault-relative document path.
 *
 * Rejects absolute paths, parent traversal, Windows drive letters, UNC prefixes and NUL
 * bytes. Without this, `?doc=../../../../etc/passwd.md` would have the vault writing its
 * CRDT contents anywhere the process could reach.
 */
export function isSafeDocPath(path: string): boolean {
  if (!path || path.length > 1024) return false;
  if (path.includes("\0")) return false;
  // Control characters have no place in a filename and are a classic way to smuggle
  // something past a log or a display.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;

  // Defeat encoding tricks: "..%2f..%2fetc" survives a naive separator check because it
  // contains no literal slash, but any layer that decodes it later sees traversal. If the
  // decoded form would not be safe, neither is this one.
  if (path.includes("%")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return false; // Malformed escape sequence.
    }
    if (decoded !== path && !isSafeDocPath(decoded)) return false;
  }

  const normalised = path.replace(/\\/g, "/");
  if (normalised.startsWith("/")) return false;
  if (/^[a-zA-Z]:/.test(normalised)) return false;
  if (normalised.startsWith("//")) return false;

  const segments = normalised.split("/");
  if (segments.some((s) => s === ".." || s === "." || s === "")) return false;
  // Never expose repository or dependency internals through a document path.
  if (segments.some((s) => s === ".git" || s === "node_modules")) return false;
  return true;
}
