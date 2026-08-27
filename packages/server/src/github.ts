/**
 * Live GitHub search for Discover.
 *
 * The curated index is small and hand-checked; this is the escape hatch for everything
 * else. It uses the *repository* search endpoint, which works unauthenticated -- GitHub's
 * code-search API requires a token, and requiring one would mean requiring an account.
 *
 * Unauthenticated search is limited to roughly ten requests a minute, so results are
 * cached and rate limiting is reported honestly rather than surfaced as a generic failure.
 */

export interface GithubHit {
  id: string;
  title: string;
  byline: string;
  description: string;
  repo: string;
  branch: string;
  stars: number;
  license: string;
  updated: string;
  source: string;
}

interface CacheRow {
  at: number;
  hits: GithubHit[];
}

const cache = new Map<string, CacheRow>();
const TTL_MS = 10 * 60 * 1000;

export class GithubSearchError extends Error {
  constructor(message: string, readonly retryAfterSeconds?: number) {
    super(message);
  }
}

/**
 * Bias the query toward repositories that exist to hold Markdown documents rather than
 * code that happens to contain some. Without this, "UI skill" mostly returns applications.
 */
function buildQuery(raw: string): string {
  const cleaned = raw.trim().replace(/[^\w\s.+#-]/g, " ").replace(/\s+/g, " ").slice(0, 120);
  return `${cleaned} in:name,description,topics`;
}

export async function searchGithub(query: string, limit = 24): Promise<GithubHit[]> {
  if (!query.trim()) return [];

  const key = `${query.trim().toLowerCase()}::${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.hits;

  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", buildQuery(query));
  url.searchParams.set("sort", "stars");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", String(Math.min(limit, 50)));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "quire-discover",
        // A token is optional and never required. When present it is the operator's own,
        // read from the environment; Quire neither stores nor asks for credentials.
        ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
    });

    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0);
      const wait = reset ? Math.max(1, Math.ceil(reset - Date.now() / 1000)) : 60;
      throw new GithubSearchError(
        `GitHub is rate limiting anonymous search. Try again in about ${wait}s.`,
        wait,
      );
    }
    if (!res.ok) throw new GithubSearchError(`GitHub search responded ${res.status}`);

    const body = (await res.json()) as {
      items?: Array<{
        full_name: string;
        description: string | null;
        stargazers_count: number;
        default_branch: string;
        pushed_at: string;
        owner?: { login?: string };
        license?: { spdx_id?: string } | null;
        archived?: boolean;
        fork?: boolean;
      }>;
    };

    const hits: GithubHit[] = (body.items ?? [])
      .filter((r) => !r.archived && !r.fork)
      .map((r) => ({
        id: `gh:${r.full_name}`,
        title: r.full_name.split("/")[1] ?? r.full_name,
        byline: r.owner?.login ?? r.full_name.split("/")[0] ?? "",
        description: r.description ?? "No description.",
        repo: r.full_name,
        branch: r.default_branch,
        stars: r.stargazers_count,
        license: r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : "See repository",
        updated: r.pushed_at.slice(0, 10),
        source: `https://github.com/${r.full_name}`,
      }));

    cache.set(key, { at: Date.now(), hits });
    return hits;
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new GithubSearchError("GitHub search timed out.");
    throw error instanceof GithubSearchError ? error : new GithubSearchError((error as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/** List the Markdown documents at a repository's root, so a hit can be installed. */
export async function listMarkdown(repo: string, branch: string): Promise<Array<{ path: string; size: number }>> {
  const safeRepo = repo.replace(/[^\w./-]/g, "");
  const res = await fetch(`https://api.github.com/repos/${safeRepo}/contents/`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "quire-discover",
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (res.status === 403 || res.status === 429) {
    throw new GithubSearchError("GitHub is rate limiting anonymous requests. Try again shortly.");
  }
  if (!res.ok) throw new GithubSearchError(`Could not list ${repo} (${res.status})`);

  const body = (await res.json()) as Array<{ name: string; path: string; size: number; type: string }>;
  return body
    .filter((e) => e.type === "file" && /\.(md|markdown)$/i.test(e.name))
    .map((e) => ({ path: e.path, size: e.size }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
