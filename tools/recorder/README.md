# Demo recorder

Records `docs/demo.gif` by driving the **real** application, not a mockup. A scripted human
types in the editor while a real `AgentSession` edits the same CRDT document. The walkthrough
also exercises suggestions, comments, authorship, provenance and policy, export, sharing, and
display controls.

Requires Google Chrome (used via `puppeteer-core`, so nothing is downloaded).

```bash
# 1. Build and serve a disposable vault with history enabled
npm run build
node packages/cli/bin/quire.js /tmp/quire-demo-vault --port 4430 --history

# 2. Install recorder-only dependencies without changing the root package
cd tools/recorder
npm install --no-save --package-lock=false --ignore-scripts puppeteer-core gifenc pngjs

# 3. Record and encode
QUIRE_URL=http://127.0.0.1:4430 node record.mjs
SCALE=1.5 COLORS=64 OUT=../../docs/demo.gif node encode.mjs

# 4. Regenerate launch media from the captured real-app frames
SCALE=1.5 COLORS=48 STEP=2 OUT=../../docs/demo.gif node encode.mjs
START=0 END=205 SCALE=1.8 COLORS=48 STEP=2 OUT=../../docs/demo-short.gif node encode.mjs
node render-assets.mjs
```

`render-assets.mjs` produces the 1280x640 social preview, a current static product screenshot, and
the 240x240 Product Hunt thumbnail. `START`, `END`, and `STEP` let the GIF encoder produce shorter,
lighter cuts without changing the timing of the captured interaction.

`SCALE` trades size for legibility (1.5 lands near GitHub's render width); `COLORS` sets
the shared palette. The palette is computed once across sampled frames rather than per
frame, which stops the warm background shimmering as the quantiser drifts.
