export interface RegistryEntry {
  id: string;
  title: string;
  byline: string;
  description: string;
  category: string;
  repo: string;
  license: string;
  stars: number;
  installAs: string;
  source: string;
}

export interface Registry {
  available: boolean;
  note?: string;
  categories: Array<{ id: string; label: string; blurb: string }>;
  entries: RegistryEntry[];
}

const fmtStars = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);

export interface DiscoverHandlers {
  onPreview: (entry: RegistryEntry) => void;
  onInstall: (entry: RegistryEntry) => void;
  installed: (entry: RegistryEntry) => boolean;
}

/**
 * The Discover gallery.
 *
 * Entries are an index only: nothing is mirrored here, and each card names the repository
 * and licence it will pull from, so installing is never a mystery about where a file came
 * from or what terms it carries.
 */
export function renderGallery(
  target: HTMLElement,
  registry: Registry,
  filter: { category: string | null; query: string },
  handlers: DiscoverHandlers,
): void {
  const query = filter.query.trim().toLowerCase();
  const entries = registry.entries
    .filter((e) => !filter.category || e.category === filter.category)
    .filter(
      (e) =>
        !query ||
        `${e.title} ${e.byline} ${e.description} ${e.repo}`.toLowerCase().includes(query),
    )
    .sort((a, b) => b.stars - a.stars);

  if (entries.length === 0) {
    target.replaceChildren(
      Object.assign(document.createElement("p"), {
        className: "empty-note",
        textContent: "Nothing matches that. Try a different word, or clear the filter.",
      }),
    );
    return;
  }

  target.replaceChildren(
    ...entries.map((entry) => {
      const card = document.createElement("article");
      card.className = "gallery-card";

      const head = document.createElement("header");
      const title = document.createElement("h3");
      title.textContent = entry.title;
      const stars = document.createElement("span");
      stars.className = "stars";
      stars.textContent = `★ ${fmtStars(entry.stars)}`;
      stars.title = `${entry.stars.toLocaleString()} stars on GitHub`;
      head.append(title, stars);

      const by = document.createElement("p");
      by.className = "byline";
      by.textContent = entry.repo;

      const desc = document.createElement("p");
      desc.className = "desc";
      desc.textContent = entry.description;

      const foot = document.createElement("footer");
      const licence = document.createElement("span");
      licence.className = "licence";
      licence.textContent = entry.license;

      const preview = document.createElement("button");
      preview.className = "ghost-sm";
      preview.textContent = "Preview";
      preview.onclick = () => handlers.onPreview(entry);

      const install = document.createElement("button");
      const already = handlers.installed(entry);
      install.className = already ? "ghost-sm" : "ghost-sm primary";
      install.textContent = already ? "In vault" : "Add to vault";
      install.disabled = already;
      install.title = already ? `${entry.installAs} is already here` : `Save as ${entry.installAs}`;
      install.onclick = () => handlers.onInstall(entry);

      foot.append(licence, preview, install);
      card.append(head, by, desc, foot);
      return card;
    }),
  );
}
