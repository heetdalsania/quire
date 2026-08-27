import { randomBytes } from "node:crypto";

export type ShareRole = "view" | "comment" | "edit";

export interface Share {
  token: string;
  role: ShareRole;
  /** Restrict to one document, or null for the whole vault. */
  path: string | null;
  createdAt: number;
  expiresAt: number | null;
  label: string;
}

/**
 * Capability links.
 *
 * Quire has no accounts, so a share link *is* the credential: holding the token is the
 * permission. That is deliberate -- it keeps sharing free and signup-free -- but it means
 * a link is as sensitive as the documents behind it, and anyone who has it has the role
 * baked into it.
 *
 * Shares live in memory only. Restarting the server invalidates every link, which is the
 * safer default: links cannot outlive the session that created them by accident.
 */
export class ShareRegistry {
  private readonly shares = new Map<string, Share>();

  create(input: { role: ShareRole; path?: string | null; ttlMs?: number | null; label?: string }): Share {
    const token = randomBytes(18).toString("base64url");
    const share: Share = {
      token,
      role: input.role,
      path: input.path ?? null,
      createdAt: Date.now(),
      expiresAt: input.ttlMs ? Date.now() + input.ttlMs : null,
      label: input.label ?? (input.path ?? "whole vault"),
    };
    this.shares.set(token, share);
    return share;
  }

  resolve(token: string | null | undefined): Share | null {
    if (!token) return null;
    const share = this.shares.get(token);
    if (!share) return null;
    if (share.expiresAt !== null && Date.now() > share.expiresAt) {
      this.shares.delete(token);
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
    return this.shares.delete(token);
  }
}
