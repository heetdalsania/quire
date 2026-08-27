import * as Y from "yjs";

/**
 * Agent leashes.
 *
 * A constraint written into a prompt is advice: the model can talk itself out of it, and
 * frequently does. A constraint enforced by the document cannot be argued with. Everything
 * here is checked where writes actually land, so it holds regardless of which agent
 * connects or what it was told.
 *
 * The policy lives in the document, so it travels with the file and applies to every
 * session rather than to whoever happened to configure their client.
 */

const POLICY_KEY = "agentPolicy";

export type AgentMode =
  /** Agents may edit directly. */
  | "edit"
  /** Agents may only propose; every write is marked as a suggestion. */
  | "propose"
  /** Agents may read but not write at all. */
  | "read-only";

export interface AgentPolicy {
  mode: AgentMode;
  /** Characters an agent may insert in one session. */
  maxInserts: number;
  /** Characters an agent may delete in one session. */
  maxDeletes: number;
  /**
   * Headings whose sections agents must not touch, matched on heading text.
   * Empty means no locked sections.
   */
  lockedSections: string[];
}

export const DEFAULT_POLICY: AgentPolicy = {
  mode: "edit",
  maxInserts: 20_000,
  // Deliberately far tighter than inserts. Runaway deletion is the failure that loses
  // work; runaway insertion is merely noisy and is trivially reverted by author.
  maxDeletes: 2_000,
  lockedSections: [],
};

export function readPolicy(doc: Y.Doc): AgentPolicy {
  const stored = doc.getMap<unknown>(POLICY_KEY);
  if (stored.size === 0) return { ...DEFAULT_POLICY };
  return {
    mode: (stored.get("mode") as AgentMode) ?? DEFAULT_POLICY.mode,
    maxInserts: (stored.get("maxInserts") as number) ?? DEFAULT_POLICY.maxInserts,
    maxDeletes: (stored.get("maxDeletes") as number) ?? DEFAULT_POLICY.maxDeletes,
    lockedSections: (stored.get("lockedSections") as string[]) ?? [],
  };
}

export function writePolicy(doc: Y.Doc, policy: Partial<AgentPolicy>): AgentPolicy {
  const next = { ...readPolicy(doc), ...policy };
  const stored = doc.getMap<unknown>(POLICY_KEY);
  doc.transact(() => {
    stored.set("mode", next.mode);
    stored.set("maxInserts", next.maxInserts);
    stored.set("maxDeletes", next.maxDeletes);
    stored.set("lockedSections", next.lockedSections);
  }, "policy");
  return next;
}

export interface UpdateShape {
  inserted: number;
  deleted: number;
}

/**
 * Measure what an incoming update would do, without applying it.
 *
 * Yjs updates are opaque bytes on the wire, so enforcing a budget means decoding them
 * first. Insertions are counted from string content in the struct list; deletions come
 * from the delete set, which records ranges of clocks rather than characters -- close
 * enough to a character count for budgeting, and it errs high, which is the safe
 * direction for a limit.
 */
export function measureUpdate(update: Uint8Array): UpdateShape {
  let inserted = 0;
  let deleted = 0;
  try {
    const decoded = Y.decodeUpdate(update);
    for (const struct of decoded.structs) {
      const content = (struct as { content?: { str?: string; getLength?: () => number } }).content;
      if (typeof content?.str === "string") inserted += content.str.length;
    }
    // ds.clients is a Map keyed by client id, not a plain object -- Object.values on it
    // silently yields nothing, which reads as "no deletions" and disables the budget.
    const clients = decoded.ds.clients as unknown as
      | Map<number, Array<{ len: number }>>
      | Record<string, Array<{ len: number }>>;
    const buckets =
      clients instanceof Map ? [...clients.values()] : Object.values(clients ?? {});
    for (const ranges of buckets) {
      for (const range of ranges) deleted += range.len;
    }
  } catch {
    // Undecodable updates are rejected elsewhere; report nothing rather than guessing.
  }
  return { inserted, deleted };
}

/** Running totals for one agent connection. */
export class AgentBudget {
  private inserted = 0;
  private deleted = 0;

  constructor(private policy: AgentPolicy) {}

  update(policy: AgentPolicy): void {
    this.policy = policy;
  }

  get spent(): UpdateShape {
    return { inserted: this.inserted, deleted: this.deleted };
  }

  get remaining(): UpdateShape {
    return {
      inserted: Math.max(0, this.policy.maxInserts - this.inserted),
      deleted: Math.max(0, this.policy.maxDeletes - this.deleted),
    };
  }

  /**
   * Decide whether an update may be applied, and account for it if so.
   *
   * Rejected updates are not counted: an agent that hits its ceiling should not also be
   * punished for the attempt.
   */
  admit(shape: UpdateShape): { allowed: boolean; reason?: string } {
    if (this.policy.mode === "read-only") {
      return { allowed: false, reason: "This document is read-only for agents." };
    }
    if (this.deleted + shape.deleted > this.policy.maxDeletes) {
      return {
        allowed: false,
        reason: `Deletion budget exhausted (${this.policy.maxDeletes} characters). A human needs to review before more is removed.`,
      };
    }
    if (this.inserted + shape.inserted > this.policy.maxInserts) {
      return {
        allowed: false,
        reason: `Insertion budget exhausted (${this.policy.maxInserts} characters).`,
      };
    }
    this.inserted += shape.inserted;
    this.deleted += shape.deleted;
    return { allowed: true };
  }
}

export interface Section {
  heading: string;
  from: number;
  to: number;
}

/** Split a Markdown document into heading-delimited sections. */
export function sections(markdown: string): Section[] {
  const out: Section[] = [];
  const pattern = /^(#{1,6})\s+(.+)$/gm;
  const found: Array<{ heading: string; start: number }> = [];
  for (const match of markdown.matchAll(pattern)) {
    found.push({ heading: match[2]!.trim(), start: match.index ?? 0 });
  }
  for (let i = 0; i < found.length; i++) {
    out.push({
      heading: found[i]!.heading,
      from: found[i]!.start,
      to: found[i + 1]?.start ?? markdown.length,
    });
  }
  return out;
}

/** Character ranges an agent must not touch, given the document's locked headings. */
export function lockedRanges(markdown: string, locked: string[]): Section[] {
  if (locked.length === 0) return [];
  const wanted = new Set(locked.map((h) => h.trim().toLowerCase()));
  return sections(markdown).filter((s) => wanted.has(s.heading.toLowerCase()));
}

export function isRangeLocked(
  markdown: string,
  locked: string[],
  from: number,
  to: number,
): Section | null {
  return lockedRanges(markdown, locked).find((s) => from < s.to && to > s.from) ?? null;
}

/**
 * Which root types an update touches.
 *
 * This is what makes a comment-only link enforceable rather than advisory, and it is
 * fiddlier than it looks. Yjs only encodes a parent's *name* for an item that has no
 * neighbour; an insert made next to existing text carries an origin instead, and the
 * parent is inferred at apply time from the item beside it. Classifying only the explicit
 * names therefore sees nothing for virtually every real edit -- which reads as "touches
 * nothing" and lets it straight through.
 *
 * So unnamed parents are resolved by following the origin back into the document, and
 * anything still unresolved is reported as unknown. Deletions get the same treatment:
 * they reference clock ranges rather than parents, so they are looked up too.
 */
export function updateTargets(update: Uint8Array, doc: Y.Doc): Set<string> {
  const targets = new Set<string>();
  try {
    const decoded = Y.decodeUpdate(update);

    for (const struct of decoded.structs) {
      const name = resolveTarget(struct, doc, 0);
      if (name) targets.add(name);
    }

    const clients = decoded.ds.clients as unknown as
      | Map<number, Array<{ clock: number; len: number }>>
      | Record<string, Array<{ clock: number; len: number }>>;
    const buckets: Array<[number, Array<{ clock: number; len: number }>]> =
      clients instanceof Map
        ? [...clients.entries()]
        : Object.entries(clients ?? {}).map(([k, v]) => [Number(k), v]);

    for (const [clientId, ranges] of buckets) {
      for (const range of ranges) {
        for (let clock = range.clock; clock < range.clock + range.len; ) {
          const found = structAt(doc, clientId, clock);
          if (!found) {
            // Deleting something this document has never seen is unattributable.
            targets.add(UNKNOWN_TARGET);
            break;
          }
          targets.add(resolveTarget(found, doc, 0) ?? UNKNOWN_TARGET);
          clock = found.id.clock + Math.max(1, found.length);
        }
      }
    }
  } catch {
    targets.add(UNKNOWN_TARGET);
  }
  return targets;
}

/** Reported when an update cannot be attributed to a root type. */
export const UNKNOWN_TARGET = "?";

interface StructLike {
  id: { client: number; clock: number };
  length: number;
  parent?: unknown;
  origin?: { client: number; clock: number } | null;
  rightOrigin?: { client: number; clock: number } | null;
}

/** Find the struct covering a clock, by binary search over a client's ordered structs. */
function structAt(doc: Y.Doc, client: number, clock: number): StructLike | null {
  const structs = doc.store.clients.get(client) as unknown as StructLike[] | undefined;
  if (!structs || structs.length === 0) return null;

  let low = 0;
  let high = structs.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const struct = structs[mid]!;
    if (clock < struct.id.clock) high = mid - 1;
    else if (clock >= struct.id.clock + struct.length) low = mid + 1;
    else return struct;
  }
  return null;
}

/** The root type a struct belongs to, following origins when the parent is not encoded. */
function resolveTarget(struct: unknown, doc: Y.Doc, depth: number): string | null {
  if (depth > 24) return UNKNOWN_TARGET;
  const item = struct as StructLike;

  if (typeof item.parent === "string") return item.parent;
  if (item.parent) return rootNameOf(item.parent, doc) ?? UNKNOWN_TARGET;

  // No encoded parent: this item was inserted beside another, so ask that one.
  for (const origin of [item.origin, item.rightOrigin]) {
    if (!origin) continue;
    const neighbour = structAt(doc, origin.client, origin.clock);
    if (neighbour) return resolveTarget(neighbour, doc, depth + 1);
  }
  return null;
}

/** Walk up to the root type and report the name it is registered under. */
function rootNameOf(type: unknown, doc: Y.Doc): string | null {
  let current = type as { _item?: { parent?: unknown } | null } | null;
  for (let depth = 0; current && depth < 32; depth++) {
    const item = current._item;
    if (!item) break;
    current = item.parent as typeof current;
  }
  for (const [name, root] of doc.share.entries()) {
    if (root === (current as unknown)) return name;
  }
  return null;
}

/** Root types a comment-only participant may write to. */
export const COMMENT_ROLE_ROOTS = new Set(["comments", "authors"]);

export function isCommentOnlyUpdate(update: Uint8Array, doc: Y.Doc): boolean {
  const targets = updateTargets(update, doc);
  // An update that classifies as nothing is either genuinely empty or something we could
  // not read. Only the first is safe, so require it to be provably empty.
  if (targets.size === 0) return isEmptyUpdate(update);
  return [...targets].every((name) => COMMENT_ROLE_ROOTS.has(name));
}

/** True when an update carries neither content nor deletions. */
function isEmptyUpdate(update: Uint8Array): boolean {
  try {
    const decoded = Y.decodeUpdate(update);
    if (decoded.structs.length > 0) return false;
    const clients = decoded.ds.clients as unknown as Map<number, unknown[]> | Record<string, unknown[]>;
    const buckets = clients instanceof Map ? [...clients.values()] : Object.values(clients ?? {});
    return buckets.every((ranges) => (ranges as unknown[]).length === 0);
  } catch {
    return false;
  }
}
