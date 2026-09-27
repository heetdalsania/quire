import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ShareRole = "view" | "comment" | "edit";

export interface Share {
  token: string;
  role: ShareRole;
  /** Restrict to one document, or null for the whole vault. */
  path: string | null;
  createdAt: number;
  expiresAt: number | null;
  label: string;
  /** What the reviewer is being asked to look at. */
  brief: string | null;
  requestedBy: string | null;
}

/**
 * Capability links.
 *
 * Quire has no accounts, so a share link *is* the credential: holding the token is the
 * permission. That is deliberate -- it keeps sharing free and signup-free -- but it means
 * a link is as sensitive as the documents behind it, and anyone who has it has the role
 * baked into it.
 *
 * Shares live in memory by default. An explicitly configured private store allows a
 * long-running team vault to keep its links across a supervised restart.
 */
export class ShareRegistry {
  private readonly shares = new Map<string, Share>();

  constructor(private readonly storePath?: string) {
    if (!storePath) return;
    if (process.platform === "win32") {
      throw new Error("Private share-store permissions cannot be verified on Windows; --share-store is unavailable there");
    }
    const parent = lstatSync(dirname(storePath));
    if (!parent.isDirectory() || (parent.mode & 0o022) !== 0 || (process.getuid && parent.uid !== process.getuid())) {
      throw new Error("Share store directory must be owned by the current user and not writable by others");
    }
    const stat = lstatSync(storePath);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("Share store must be a private regular file owned by the current user (mode 600)");
    }
    const data: unknown = JSON.parse(readFileSync(storePath, "utf8"));
    if (!data || typeof data !== "object" || !Array.isArray((data as { shares?: unknown }).shares)) {
      throw new Error("Invalid share store");
    }
    for (const item of (data as { shares: unknown[] }).shares) {
      if (!validShare(item) || this.shares.has(item.token)) throw new Error("Invalid share store entry");
      this.shares.set(item.token, item);
    }
  }

  private persist(): void {
    if (!this.storePath) return;
    const temp = `${this.storePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ shares: [...this.shares.values()] }), { flag: "wx", mode: 0o600 });
      renameSync(temp, this.storePath);
    } catch (error) {
      try { unlinkSync(temp); } catch { /* Temporary file may not have been created. */ }
      throw error;
    }
  }

  create(input: {
    role: ShareRole;
    path?: string | null;
    ttlMs?: number | null;
    label?: string;
    brief?: string | null;
    requestedBy?: string | null;
  }): Share {
    const token = randomBytes(18).toString("base64url");
    const share: Share = {
      token,
      role: input.role,
      path: input.path ?? null,
      createdAt: Date.now(),
      expiresAt: input.ttlMs ? Date.now() + input.ttlMs : null,
      label: input.label ?? (input.path ?? "whole vault"),
      brief: input.brief ?? null,
      requestedBy: input.requestedBy ?? null,
    };
    this.shares.set(token, share);
    try { this.persist(); } catch (error) { this.shares.delete(token); throw error; }
    return share;
  }

  resolve(token: string | null | undefined): Share | null {
    if (!token) return null;
    const share = this.shares.get(token);
    if (!share) return null;
    if (share.expiresAt !== null && Date.now() > share.expiresAt) {
      this.shares.delete(token);
      this.persist();
      return null;
    }
    return share;
  }

  /** The role a request carries. No token means the local owner, who may edit. */
  roleFor(token: string | null | undefined, path: string): ShareRole | "denied" {
    if (!token) return "edit";
    const share = this.resolve(token);
    if (!share) return "denied";
    if (share.path !== null && share.path !== path) return "denied";
    return share.role;
  }

  list(): Share[] {
    return [...this.shares.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  revoke(token: string): boolean {
    const share = this.shares.get(token);
    if (!share) return false;
    this.shares.delete(token);
    try { this.persist(); } catch (error) { this.shares.set(token, share); throw error; }
    return true;
  }
}

function validShare(value: unknown): value is Share {
  if (!value || typeof value !== "object") return false;
  const share = value as Partial<Share>;
  return typeof share.token === "string" && /^[A-Za-z0-9_-]{24}$/.test(share.token)
    && (share.role === "view" || share.role === "comment" || share.role === "edit")
    && (share.path === null || typeof share.path === "string")
    && typeof share.createdAt === "number" && Number.isFinite(share.createdAt)
    && (share.expiresAt === null || (typeof share.expiresAt === "number" && Number.isFinite(share.expiresAt)))
    && typeof share.label === "string"
    && (share.brief === null || typeof share.brief === "string")
    && (share.requestedBy === null || typeof share.requestedBy === "string");
}
