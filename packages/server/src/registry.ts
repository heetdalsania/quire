import { readFile } from "node:fs/promises";
import { isSafeDocPath } from "./security.js";

export interface RegistryEntry {
  id: string;
  title: string;
  byline: string;
  description: string;
  category: string;
  repo: string;
  branch: string;
  path: string;
  installAs: string;
  license: string;
  stars: number;
}

export interface RegistryIndex {
  version: number;
  updated: string;
  note: string;
  categories: Array<{ id: string; label: string; blurb: string }>;
  entries: RegistryEntry[];
}

/**
 * The registry is an index, not a service.
 *
 * Entries name a public repository and a path; Quire fetches the file from that source at
 * install time and never mirrors, hosts or re-serves it. That keeps the whole feature free
 * of infrastructure, moderation and accounts -- submissions are pull requests against the
 * index file, the way Homebrew taps and awesome-lists already work.
 */
const RAW_HOST = "raw.githubusercontent.com";

export function rawUrl(entry: RegistryEntry): string {
  const repo = entry.repo.replace(/[^\w./-]/g, "");
  const branch = entry.branch.replace(/[^\w./-]/g, "");
  const path = entry.path.replace(/^\/+/, "");
  return `https://${RAW_HOST}/${repo}/${branch}/${path}`;
}

export function sourceUrl(entry: RegistryEntry): string {
  return `https://github.com/${entry.repo}/blob/${entry.branch}/${entry.path}`;
}

let cached: RegistryIndex | null = null;

export async function loadRegistry(indexPath: string): Promise<RegistryIndex> {
  cached ??= JSON.parse(await readFile(indexPath, "utf8")) as RegistryIndex;
  return cached;
}

export function findEntry(index: RegistryIndex, id: string): RegistryEntry | null {
  return index.entries.find((e) => e.id === id) ?? null;
}

/** Guard the install target: a registry entry must never write outside the vault. */
export function resolveInstallPath(entry: RegistryEntry, requested?: string): string | null {
  const candidate = (requested ?? entry.installAs).trim();
  if (!isSafeDocPath(candidate)) return null;
  if (!/\.(md|markdown)$/i.test(candidate)) return null;
  return candidate;
}

export class RegistryFetchError extends Error {}

/**
 * Fetch an entry's Markdown from its source repository.
 *
 * This is the only outbound network request Quire ever makes, and only when a person
 * explicitly asks for a document. The URL is derived from the index rather than supplied
 * by the caller, and the host is pinned, so a crafted request cannot turn this into a
 * general-purpose fetcher for the machine's network position.
 */
export async function fetchEntry(entry: RegistryEntry, timeoutMs = 15_000): Promise<string> {
  const url = rawUrl(entry);
  if (new URL(url).host !== RAW_HOST) throw new RegistryFetchError("Refusing a non-registry host");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "text/plain, text/markdown, */*" },
    });
    if (!res.ok) throw new RegistryFetchError(`Source responded ${res.status} for ${entry.repo}`);

    const body = await res.text();
    if (body.length > 4 * 1024 * 1024) throw new RegistryFetchError("Document is unreasonably large");
    return body;
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new RegistryFetchError("Timed out reaching the source repository");
    }
    throw error instanceof RegistryFetchError
      ? error
      : new RegistryFetchError(`Could not reach ${entry.repo}: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
