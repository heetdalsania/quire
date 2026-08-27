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

      // "See more" only appears when there is actually more: descriptions vary wildly in
      // length, and a permanent toggle on a two-line blurb is just clutter.
      const more = document.createElement("button");
      more.className = "see-more";
      more.type = "button";
      more.textContent = "See more";
      more.hidden = true;
      more.onclick = () => {
        const open = desc.classList.toggle("expanded");
        more.textContent = open ? "See less" : "See more";
      };
      // Measured after layout, when the clamped height is knowable.
      requestAnimationFrame(() => {
        more.hidden = desc.scrollHeight <= desc.clientHeight + 1;
      });

      const foot = document.createElement("footer");
      const licence = document.createElement("span");
      licence.className = "licence";
      licence.textContent = entry.license;

      const repoLink = document.createElement("a");
      repoLink.className = "icon-link";
      repoLink.href = entry.source;
      repoLink.target = "_blank";
      repoLink.rel = "noopener noreferrer";
      repoLink.title = `Open ${entry.repo} on GitHub`;
      repoLink.setAttribute("aria-label", `Open ${entry.repo} on GitHub`);
      repoLink.innerHTML =
        '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 .2a8 8 0 0 0-2.53 15.6c.4.07.55-.17.55-.38v-1.34c-2.23.49-2.7-1.07-2.7-1.07-.36-.93-.89-1.18-.89-1.18-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.83-2.15-.09-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.52.56.83 1.28.83 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 .2z"/></svg>';

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

      foot.append(licence, repoLink, preview, install);
      card.append(head, by, desc, more, foot);
      return card;
    }),
  );
}
