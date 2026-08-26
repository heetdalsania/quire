import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import gifenc from "gifenc";
const { GIFEncoder, applyPalette, quantize } = gifenc;
import { PNG } from "pngjs";

const dir = join(import.meta.dirname, "frames");
const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
const files = (await readdir(dir)).filter((f) => f.endsWith(".png")).sort();

const SCALE = Number(process.env.SCALE ?? 1);
const COLORS = Number(process.env.COLORS ?? 128);
const out = process.env.OUT ?? join(import.meta.dirname, "quire-demo.gif");

const decode = async (file) => {
  const png = PNG.sync.read(await readFile(join(dir, file)));
  if (SCALE === 1) return { data: png.data, width: png.width, height: png.height };
  // Box-filter downsample: averaging keeps antialiased text far more legible than
  // nearest-neighbour, which is what makes a shrunk UI recording readable at all.
  const w = Math.round(png.width / SCALE);
  const h = Math.round(png.height / SCALE);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y * SCALE);
    const sy1 = Math.max(sy0 + 1, Math.min(png.height, Math.ceil((y + 1) * SCALE)));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x * SCALE);
      const sx1 = Math.max(sx0 + 1, Math.min(png.width, Math.ceil((x + 1) * SCALE)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * png.width + sx) * 4;
          r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; n++;
        }
      }
      const o = (y * w + x) * 4;
      data[o] = r / n; data[o + 1] = g / n; data[o + 2] = b / n; data[o + 3] = 255;
    }
  }
  return { data, width: w, height: h };
};

// One shared palette from evenly-spaced samples: a per-frame palette makes the
// background shimmer as the quantiser picks slightly different warm tones each frame.
const samples = [];
for (let i = 0; i < files.length; i += Math.max(1, Math.floor(files.length / 12))) {
  samples.push((await decode(files[i])).data);
}
const merged = new Uint8ClampedArray(samples.reduce((n, s) => n + s.length, 0));
let at = 0;
for (const s of samples) { merged.set(s, at); at += s.length; }
const palette = quantize(merged, COLORS, { format: "rgb565" });

const gif = GIFEncoder();
const delay = Math.round(1000 / meta.fps);
let dims = null;
for (const file of files) {
  const { data, width, height } = await decode(file);
  dims ??= { width, height };
  gif.writeFrame(applyPalette(data, palette, "rgb565"), width, height, {
    palette,
    delay,
    transparent: false,
  });
}
gif.finish();
await writeFile(out, gif.bytes());
console.log(`${out}  ${dims.width}x${dims.height}  ${files.length} frames  ${(gif.bytes().length / 1048576).toFixed(2)} MB`);
