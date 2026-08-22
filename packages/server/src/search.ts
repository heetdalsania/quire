import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

/**
 * Full-text search via ripgrep, falling back to a plain scan when rg is absent.
 * ripgrep is optional precisely so `npx quire` works with nothing else installed.
 */
export async function searchVault(
  root: string,
  query: string,
  limit = 60,
): Promise<{ results: SearchHit[]; engine: "ripgrep" | "fallback" }> {
  if (!query.trim()) return { results: [], engine: "fallback" };

  try {
    const { stdout } = await exec(
      "rg",
      [
        "--json",
        "--smart-case",
        "--max-count", "5",
        "--glob", "*.md",
        "--glob", "*.markdown",
        "--", query, ".",
      ],
      { cwd: root, maxBuffer: 8 * 1024 * 1024 },
    );

    const results: SearchHit[] = [];
    for (const raw of stdout.split("\n")) {
      if (!raw) continue;
      const event = JSON.parse(raw) as {
        type: string;
        data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
      };
      if (event.type !== "match" || !event.data) continue;
      results.push({
        path: (event.data.path?.text ?? "").replace(/^\.\//, ""),
        line: event.data.line_number ?? 0,
        text: (event.data.lines?.text ?? "").trimEnd().slice(0, 300),
      });
      if (results.length >= limit) break;
    }
    return { results, engine: "ripgrep" };
  } catch {
    return { results: [], engine: "fallback" };
  }
}

/** In-process fallback so search still works without ripgrep installed. */
export function searchDocuments(
  documents: Array<{ path: string; text: string }>,
  query: string,
  limit = 60,
): SearchHit[] {
  const needle = query.toLowerCase();
  const results: SearchHit[] = [];
  for (const doc of documents) {
    const lines = doc.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.toLowerCase().includes(needle)) {
        results.push({ path: doc.path, line: i + 1, text: line.trimEnd().slice(0, 300) });
        if (results.length >= limit) return results;
      }
    }
  }
  return results;
}
