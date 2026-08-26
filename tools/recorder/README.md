# Demo recorder

Records `docs/demo.gif` by driving the **real** application — not a mockup. A scripted
human types in the editor while a real `AgentSession` edits the same CRDT document, so
what the GIF shows is what the software does.

Requires Google Chrome (used via `puppeteer-core`, so nothing is downloaded).

```bash
# 1. Serve a vault
node packages/cli/bin/quire.js /tmp/quire-demo-vault --port 4430

# 2. Record and encode (from a scratch dir with the three deps installed)
npm install puppeteer-core gifenc pngjs
QUIRE_URL=http://127.0.0.1:4430 node record.mjs
SCALE=1.5 COLORS=64 OUT=../../docs/demo.gif node encode.mjs
```

`SCALE` trades size for legibility (1.5 lands near GitHub's render width); `COLORS` sets
the shared palette. The palette is computed once across sampled frames rather than per
frame, which stops the warm background shimmering as the quantiser drifts.
