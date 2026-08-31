# Markdown round-trip comparison

This test measures Markdown source fidelity, not the overall quality of either editor. Google Docs
is a strong cloud document editor and preserved much of the fixture's meaning. Quire is designed
for a different constraint: the original Markdown file remains the source of truth.

## Method

Tested on 2026-08-30 using the Google Docs web application:

1. Upload [`markdown-roundtrip.md`](../packages/bridge/test/fixtures/markdown-roundtrip.md) through
   Google Docs' **Open a file > Upload** flow.
2. Make no edits after import and wait for the document to report that it is saved.
3. Export the converted document using Google Docs' Markdown export.
4. Compare the exported bytes with the uploaded fixture using `git diff --no-index` and SHA-256.

The fixture exercises YAML frontmatter, an HTML comment, emphasis, inline code, an external link,
a wiki-link, a callout, task lists, nesting, a table, fenced TypeScript, fenced Mermaid, a
footnote with a relative link, raw HTML, escapes, repeated spaces, and a final newline. Google
documents the import and export feature in its
[Markdown help](https://support.google.com/docs/answer/12014036?hl=en).

## Results

| Measurement | Original | Google Docs export |
|---|---:|---:|
| Lines | 55 | 46 |
| Bytes | 1,193 | 1,111 |
| SHA-256 | `bae28fe2475cb520988a64a57d78ab5ceefd5968421222a89c754273c646b92b` | `28fc66f9977211526b12e478fb1ba89f996ae0c1f1cb1c409b9d9c830eff0f7c` |

The diff contained 22 inserted and 30 deleted lines. Google Docs preserved headings, emphasis,
task completion states, table data, the external link, and the footnote text. The round trip also:

- removed the HTML comment;
- flattened the YAML frontmatter structure and escaped `custom_field`;
- removed the TypeScript and Mermaid fence markers and language identifiers;
- escaped the wiki-link and callout syntax;
- removed and flattened the raw HTML block;
- renumbered the footnote and changed `../guide.md` to `http://../guide.md`;
- changed list indentation, table delimiter alignment, line wrapping, spaces, and the final newline.

Quire's automated test loads the same fixture into a vault, opens it through the collaboration
bridge, flushes the unchanged session, and asserts byte equality before and after. Run it with:

```bash
npm test -- --run packages/bridge/test/bridge.test.ts
```

## Conclusion

Google Docs' Markdown support is useful for semantic import, cloud collaboration, and later
export. This test does not show a lossless source round trip for syntax-rich Markdown. Quire's
value is narrower: editing the original local file in place while humans, agents, external
editors, and git share one continuously synchronized workspace.

This is one documented fixture against the product behavior observed on the test date, not a claim
about every Markdown document or future Google Docs release. Re-run the protocol when either
product's Markdown handling changes.
