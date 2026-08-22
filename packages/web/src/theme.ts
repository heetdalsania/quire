import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/**
 * Markdown syntax colours drawn from the same palette as the rest of the app, so the
 * source pane and the printed pane read as two views of one document rather than as an
 * editor bolted next to a preview.
 *
 * Colours resolve from CSS custom properties, which means light and dark follow the
 * page automatically without a second HighlightStyle.
 */
export const quireHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.heading1, color: "var(--text)", fontWeight: "680", fontSize: "1.18em" },
    { tag: t.heading2, color: "var(--text)", fontWeight: "660", fontSize: "1.08em" },
    { tag: [t.heading3, t.heading4, t.heading5, t.heading6], color: "var(--text)", fontWeight: "640" },
    { tag: t.strong, color: "var(--text)", fontWeight: "700" },
    { tag: t.emphasis, color: "var(--text)", fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through", color: "var(--muted)" },
    { tag: [t.link, t.url], color: "var(--pine)" },
    { tag: t.quote, color: "var(--subtle)", fontStyle: "italic" },
    { tag: [t.monospace, t.literal], color: "var(--foam)" },
    { tag: [t.list, t.labelName], color: "var(--iris)" },
    // Markdown punctuation: the #, *, ` and [] scaffolding. Recede it so prose leads.
    { tag: [t.processingInstruction, t.meta], color: "var(--muted)" },
    { tag: t.contentSeparator, color: "var(--muted)" },
    { tag: t.comment, color: "var(--muted)", fontStyle: "italic" },
  ]),
);

/**
 * Editor chrome.
 *
 * Defined as a CodeMirror theme rather than plain CSS on purpose: CodeMirror injects its
 * own light/dark base styles into a stylesheet that outranks an ordinary `.cm-gutters`
 * rule, which left the gutter painted light-grey on a dark page. Going through
 * EditorView.theme puts these declarations in the same cascade layer, so they win
 * without a specificity arms race.
 *
 * Every colour is a CSS custom property, so light and dark follow the page with no
 * second theme and no flash on switch.
 */
export const quireEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--text)",
    fontFamily: "var(--font-mono)",
    fontSize: "13.5px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.7", padding: "22px 0 60px" },
  ".cm-content": { caretColor: "var(--accent)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "color-mix(in srgb, var(--muted) 70%, transparent)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 16px", fontSize: "11.5px" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--text) 4%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--subtle)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)",
  },
  ".cm-ySelectionInfo": {
    fontFamily: "var(--font-ui)",
    fontSize: "10.5px",
    fontWeight: "600",
    padding: "1px 5px",
    borderRadius: "4px 4px 4px 0",
  },
});
