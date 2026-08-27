import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type RegistryEntry, fetchEntry } from "./registry.js";

/**
 * A lockfile for prose.
 *
 * People fork a popular CLAUDE.md, edit it to suit their project, and never learn that the
 * original improved. Every dependency ecosystem solved this decades ago; documents never
 * did. This records what was installed and what it looked like at the time, so drift in
 * either direction can be detected and, crucially, told apart.
 *
 * Kept as a plain JSON file in the vault so it travels with the repository and is
 * reviewable in a diff, like any other lockfile.
 */

const LOCKFILE = "quire.lock";

export interface LockedDocument {
  path: string;
  repo: string;
  branch: string;
  sourcePath: string;
  /** Hash of the upstream text as installed, before any local edits. */
  installedHash: string;
  installedAt: string;
  license: string;
  title: string;
}

export interface Lockfile {
  version: 1;
  documents: Record<string, LockedDocument>;
}

const EMPTY: Lockfile = { version: 1, documents: {} };

export const hashText = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);

export async function readLockfile(root: string): Promise<Lockfile> {
  try {
    const parsed = JSON.parse(await readFile(join(root, LOCKFILE), "utf8")) as Lockfile;
    return parsed.version === 1 && parsed.documents ? parsed : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

export async function recordInstall(
  root: string,
  entry: RegistryEntry,
  targetPath: string,
  upstreamText: string,
): Promise<void> {
  const lock = await readLockfile(root);
  lock.documents[targetPath] = {
    path: targetPath,
    repo: entry.repo,
    branch: entry.branch,
    sourcePath: entry.path,
    installedHash: hashText(upstreamText),
    installedAt: new Date().toISOString(),
    license: entry.license,
    title: entry.title,
  };
  await writeFile(join(root, LOCKFILE), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

export type DriftState =
  /** Neither side moved. */
  | "current"
  /** Upstream changed; the local copy has not. Safe to update. */
  | "upstream-changed"
  /** The local copy was edited; upstream has not moved. */
  | "locally-edited"
  /** Both moved. Updating means merging. */
  | "diverged"
  /** Upstream could not be reached. */
  | "unknown";

export interface DriftReport {
  path: string;
  title: string;
  repo: string;
  state: DriftState;
  upstreamText?: string;
  detail: string;
}

/**
 * Local content is compared with the provenance header stripped, since Quire wrote that
 * line itself and it would otherwise register as a local edit on every document.
 */
export function stripProvenanceHeader(text: string): string {
  return text.replace(/^<!--\s*Installed by Quire[\s\S]*?-->\n{0,2}/, "");
}

/**
 * Compare an installed document against its source.
 *
 * The fetcher is injected rather than called directly so the classification can be tested
 * without reaching the network -- which is the part worth testing.
 */
export async function checkDrift(
  fetchUpstream: (locked: LockedDocument) => Promise<string>,
  locked: LockedDocument,
  localText: string,
): Promise<DriftReport> {
  const localHash = hashText(stripProvenanceHeader(localText));
  const localMoved = localHash !== locked.installedHash;

  let upstreamText: string;
  try {
    upstreamText = await fetchUpstream(locked);
  } catch (error) {
    return {
      path: locked.path,
      title: locked.title,
      repo: locked.repo,
      state: "unknown",
      detail: `Could not reach ${locked.repo}: ${(error as Error).message}`,
    };
  }

  const upstreamMoved = hashText(upstreamText) !== locked.installedHash;

  const state: DriftState = upstreamMoved
    ? localMoved
      ? "diverged"
      : "upstream-changed"
    : localMoved
      ? "locally-edited"
      : "current";

  const detail = {
    current: "Matches upstream.",
    "upstream-changed": "Upstream has moved on. Your copy is unedited, so updating is clean.",
    "locally-edited": "You have edited this. Upstream has not changed.",
    diverged: "Both you and upstream have changed this. Updating means merging.",
    unknown: "",
  }[state];

  return { path: locked.path, title: locked.title, repo: locked.repo, state, upstreamText, detail };
}
