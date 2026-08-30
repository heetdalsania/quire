import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const REPO = join(import.meta.dirname, "../..");
const FRAMES = join(import.meta.dirname, "frames");
const DOCS = join(REPO, "docs");
const heroFrame = join(FRAMES, process.env.HERO_FRAME ?? "f0200.png");
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

await stat(heroFrame).catch(() => {
  throw new Error("Recorder frames are missing. Run record.mjs before rendering launch assets.");
});
await mkdir(DOCS, { recursive: true });
await copyFile(heroFrame, join(DOCS, "product-screenshot.png"));

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: "shell",
  args: ["--hide-scrollbars", "--force-color-profile=srgb"],
});

async function render({ width, height, html, out }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "networkidle0" });
  await page.screenshot({ path: join(DOCS, out), type: "png" });
  await page.close();
}

const screenshot = `data:image/png;base64,${(await readFile(heroFrame)).toString("base64")}`;
await render({
  width: 1280,
  height: 640,
  out: "social-preview.png",
  html: `<!doctype html><style>
    * { box-sizing: border-box; }
    body { margin: 0; width: 1280px; height: 640px; overflow: hidden; background: #f7f4ef;
      color: #29263b; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .brand { position: absolute; left: 70px; top: 66px; width: 500px; z-index: 2; }
    .mark { display: flex; align-items: center; gap: 16px; font-size: 28px; font-weight: 750; }
    .icon { width: 42px; height: 48px; background: #907aa9; border: 3px solid #29263b;
      box-shadow: 7px 7px 0 #ea9d34; }
    h1 { margin: 54px 0 22px; font-family: Georgia, serif; font-size: 61px; line-height: 1.02;
      font-weight: 700; letter-spacing: 0; }
    p { margin: 0; width: 460px; font-size: 25px; line-height: 1.35; color: #514c68; }
    .command { display: inline-block; margin-top: 34px; padding: 13px 17px; background: #29263b;
      color: #fff; border-radius: 5px; font: 19px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .shot { position: absolute; left: 600px; top: 58px; width: 790px; height: 524px; object-fit: cover;
      object-position: left center; border: 1px solid #cbc4d4; border-radius: 6px;
      box-shadow: 0 18px 48px rgba(42, 37, 57, .16); }
    .rule { position: absolute; left: 0; bottom: 0; width: 1280px; height: 10px; display: flex; }
    .rule span:nth-child(1) { flex: 34; background: #907aa9; }
    .rule span:nth-child(2) { flex: 33; background: #ea9d34; }
    .rule span:nth-child(3) { flex: 33; background: #188b98; }
  </style><img class="shot" src="${screenshot}"><div class="brand">
    <div class="mark"><span class="icon"></span>QUIRE</div>
    <h1>Markdown,<br>edited together.</h1>
    <p>Local-first collaboration with AI agents you can see, review, and constrain.</p>
    <span class="command">npx quiredocs --demo</span>
  </div><div class="rule"><span></span><span></span><span></span></div>`,
});

await render({
  width: 240,
  height: 240,
  out: "product-hunt-thumbnail.png",
  html: `<!doctype html><style>
    * { box-sizing: border-box; }
    body { margin: 0; width: 240px; height: 240px; display: grid; place-items: center;
      background: #29263b; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { text-align: center; }
    .icon { width: 72px; height: 82px; margin: 0 auto 22px; background: #907aa9;
      border: 4px solid #f7f4ef; box-shadow: 11px 11px 0 #ea9d34; }
    strong { display: block; font-family: Georgia, serif; font-size: 31px; letter-spacing: 0; }
    span { display: block; margin-top: 7px; color: #c7c1d8; font-size: 13px; letter-spacing: 0; }
  </style><main><div class="icon"></div><strong>Quire</strong><span>Markdown x agents</span></main>`,
});

await browser.close();

for (const name of ["social-preview.png", "product-screenshot.png", "product-hunt-thumbnail.png"]) {
  const bytes = (await stat(join(DOCS, name))).size;
  console.log(`${name} ${(bytes / 1024).toFixed(0)} KB`);
}
