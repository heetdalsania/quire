# Demo recorder

Records `docs/demo.gif` by driving the **real** application, not a mockup. A scripted human
types in the editor while a real `AgentSession` edits the same CRDT document. The walkthrough
also exercises suggestions, comments, authorship, provenance and policy, export, sharing, and
display controls.

Requires Google Chrome (used via `puppeteer-core`, so no browser is downloaded).
`demo.mjs` creates the sample files in a temporary vault, starts a loopback-only server,
runs the recorder, then stops the server and removes the vault.

For three focused, captioned GIFs (concurrent editing, suggestion review, and removing agent
additions), build the app and run `node tools/recorder/social.mjs`. This uses the project's
Playwright Chromium and the recorder-only `gifenc`/`pngjs` dependencies listed below. Outputs
go to the ignored `tools/recorder/output` directory, or `OUT_DIR` when supplied. The recordings
use scripted input through real editing sessions, not live model responses. Captions disclose
this. The recorder asserts the visible results and checks that unaccepted suggestions stay off disk.

```bash
# 1. Build the application
npm run build

# 2. Install recorder-only dependencies without changing the root package
cd tools/recorder
npm install --no-save --package-lock=false --ignore-scripts puppeteer-core gifenc pngjs

# 3. Record and encode
node demo.mjs
SCALE=1.5 COLORS=64 OUT=../../docs/demo.gif node encode.mjs

# 4. Regenerate launch media from the captured real-app frames
SCALE=1.5 COLORS=48 STEP=2 OUT=../../docs/demo.gif node encode.mjs
START=0 END=170 SCALE=1.5 COLORS=48 STEP=2 OUT=../../docs/demo-short.gif node encode.mjs
node render-assets.mjs
```

`render-assets.mjs` produces the 1280x640 social preview, a current static product screenshot, and
the 240x240 Product Hunt thumbnail. `START`, `END`, and `STEP` let the GIF encoder produce shorter,
lighter cuts without changing the timing of the captured interaction.

`SCALE` trades size for legibility (1.5 lands near GitHub's render width); `COLORS` sets
the shared palette. The palette is computed once across sampled frames rather than per
frame, which stops the warm background shimmering as the quantiser drifts.
