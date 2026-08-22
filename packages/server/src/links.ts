export interface LinkGraph {
  /** path -> the document paths it links to */
  outgoing: Record<string, string[]>;
  /** path -> the document paths that link to it */
  backlinks: Record<string, string[]>;
  /** wiki-link targets that do not resolve to a document */
  unresolved: Record<string, string[]>;
}

const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

/** Resolve a wiki-link target against known paths: exact, then basename match. */
function resolve(target: string, paths: Set<string>, byBasename: Map<string, string[]>): string | null {
  const trimmed = target.trim();
  if (!trimmed) return null;
  for (const candidate of [trimmed, `${trimmed}.md`]) {
    if (paths.has(candidate)) return candidate;
  }
  const base = trimmed.replace(/\.md$/i, "").toLowerCase();
  const matches = byBasename.get(base);
  // Ambiguous basenames are left unresolved rather than guessed at.
  return matches?.length === 1 ? matches[0]! : null;
}

export function buildLinkGraph(documents: Array<{ path: string; text: string }>): LinkGraph {
  const paths = new Set(documents.map((d) => d.path));
  const byBasename = new Map<string, string[]>();
  for (const doc of documents) {
    const base = (doc.path.split("/").pop() ?? doc.path).replace(/\.md$/i, "").toLowerCase();
    byBasename.set(base, [...(byBasename.get(base) ?? []), doc.path]);
  }

  const outgoing: Record<string, string[]> = {};
  const backlinks: Record<string, string[]> = {};
  const unresolved: Record<string, string[]> = {};
  for (const path of paths) backlinks[path] = [];

  for (const doc of documents) {
    const targets = new Set<string>();
    const misses = new Set<string>();
    for (const match of doc.text.matchAll(WIKILINK)) {
      const target = resolve(match[1] ?? "", paths, byBasename);
      if (target && target !== doc.path) targets.add(target);
      else if (!target) misses.add((match[1] ?? "").trim());
    }
    outgoing[doc.path] = [...targets].sort();
    if (misses.size > 0) unresolved[doc.path] = [...misses].sort();
    for (const target of targets) backlinks[target] = [...(backlinks[target] ?? []), doc.path];
  }

  for (const key of Object.keys(backlinks)) backlinks[key] = [...new Set(backlinks[key])].sort();
  return { outgoing, backlinks, unresolved };
}
