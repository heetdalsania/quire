import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type * as Y from "yjs";
import { ATTR_AUTHOR, ATTR_SUGGEST_DELETE, ATTR_SUGGEST_INSERT } from "@quire/bridge/attribution";

export interface AuthorStyle {
  name: string;
  color: string;
  kind: "human" | "agent";
}

/** Registry of who wrote what, populated from awareness as peers come and go. */
export const authorRegistry = new Map<string, AuthorStyle>();

let showAttribution = false;
export const isAttributionVisible = (): boolean => showAttribution;

/**
 * Paints authorship and suggestion state directly onto the text.
 *
 * Suggestions are always shown -- an un-reviewed agent proposal you cannot see is worse
 * than useless. Authorship tinting is opt-in, because permanent colour-coding makes
 * ordinary prose hard to read.
 */
export function attributionExtension(text: Y.Text, onChange: () => void) {
  const build = (): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>();
    let cursor = 0;
    const delta = text.toDelta() as Array<{ insert?: string; attributes?: Record<string, string> }>;

    for (const op of delta) {
      if (typeof op.insert !== "string") continue;
      const from = cursor;
      const to = cursor + op.insert.length;
      cursor = to;
      if (to === from) continue;

      const attrs = op.attributes ?? {};
      const author = attrs[ATTR_AUTHOR];
      const classes: string[] = [];
      const style: string[] = [];

      if (attrs[ATTR_SUGGEST_INSERT]) classes.push("q-suggest-insert");
      if (attrs[ATTR_SUGGEST_DELETE]) classes.push("q-suggest-delete");

      if (showAttribution && author) {
        const known = authorRegistry.get(author);
        classes.push("q-attributed");
        style.push(`--q-author: ${known?.color ?? "#8a8f98"}`);
      }

      if (classes.length === 0) continue;
      builder.add(
        from,
        to,
        Decoration.mark({
          class: classes.join(" "),
          attributes: {
            ...(style.length ? { style: style.join(";") } : {}),
            ...(author ? { "data-author": authorRegistry.get(author)?.name ?? author } : {}),
          },
        }),
      );
    }
    return builder.finish();
  };

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      /** Visibility the current decorations were built against. */
      private builtWith = showAttribution;
      private readonly observer: () => void;

      constructor(view: EditorView) {
        this.decorations = build();
        this.observer = () => {
          this.decorations = build();
          // Repaint on the next frame; the Yjs observer fires mid-transaction.
          queueMicrotask(() => {
            view.dispatch({});
            onChange();
          });
        };
        text.observe(this.observer);
      }

      update(update: ViewUpdate): void {
        // The Authors toggle dispatches an empty transaction, which changes neither the
        // document nor the viewport -- so it has to be tracked explicitly or the tint
        // never repaints.
        if (update.docChanged || update.viewportChanged || this.builtWith !== showAttribution) {
          this.builtWith = showAttribution;
          this.decorations = build();
        }
      }

      destroy(): void {
        text.unobserve(this.observer);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

export function setAttributionVisible(view: EditorView | null, visible: boolean): void {
  showAttribution = visible;
  view?.dispatch({});
}

export const attributionTheme = EditorView.baseTheme({
  ".q-attributed": {
    backgroundColor: "color-mix(in srgb, var(--q-author) 16%, transparent)",
    borderBottom: "1px solid color-mix(in srgb, var(--q-author) 55%, transparent)",
  },
  ".q-suggest-insert": {
    backgroundColor: "rgba(47, 158, 68, 0.20)",
    borderBottom: "2px solid rgba(47, 158, 68, 0.85)",
  },
  ".q-suggest-delete": {
    backgroundColor: "rgba(224, 49, 49, 0.16)",
    textDecoration: "line-through",
    textDecorationColor: "rgba(224, 49, 49, 0.9)",
  },
});
