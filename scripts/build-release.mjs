import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Assemble the publishable package.
 *
 * Quire is a workspace during development but ships as a single package, because the
 * onboarding promise is `npx quire <folder>` and that has to work with one install and no
 * cross-package version dance. The two entry points are bundled with their dependencies,
 * and the web client and registry are copied in beside them.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "packages/cli");

const external = [
  // fsevents is an optional native binding chokidar loads only on macOS; bundling it
  // would break the package everywhere else.
  "fsevents",
];

await rm(join(out, "dist"), { recursive: true, force: true });
await rm(join(out, "web"), { recursive: true, force: true });
await rm(join(out, "registry"), { recursive: true, force: true });
await mkdir(join(out, "dist"), { recursive: true });

for (const [entry, name] of [
  ["packages/cli/bin/quire.js", "quire.js"],
  ["packages/mcp/bin/quire-mcp.js", "quire-mcp.js"],
]) {
  const result = await build({
    entryPoints: [join(root, entry)],
    outfile: join(out, "dist", name),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    external,
    // Some dependencies (ws among them) are CommonJS and call require() for Node
    // builtins. In ESM output esbuild replaces that with a shim that throws unless a
    // global `require` exists, so one is provided from import.meta.url.
    banner: {
      js: [
        "import { createRequire as __quireCreateRequire } from 'node:module';",
        "const require = __quireCreateRequire(import.meta.url);",
      ].join("\n"),
    },
    // Keep names readable so a stack trace from a user is worth something.
    minify: false,
    logLevel: "warning",
    metafile: true,
  });
  // Exactly one shebang, at the very top. esbuild preserves the entry point's own, and
  // adding a banner as well produces a second one mid-file -- which is a syntax error
  // that only shows up once the package is installed and run.
  const file = join(out, "dist", name);
  const body = (await readFile(file, "utf8")).replace(/^#!.*\n/gm, "");
  await writeFile(file, `#!/usr/bin/env node\n${body}`);
  await chmod(file, 0o755);

  const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
  console.log(`  bundled ${name.padEnd(14)} ${(bytes / 1024).toFixed(0)} KB`);
}

await cp(join(root, "packages/web/dist"), join(out, "web"), { recursive: true });
await mkdir(join(out, "registry"), { recursive: true });
await cp(join(root, "registry/index.json"), join(out, "registry/index.json"));
for (const file of ["README.md", "LICENSE", "SECURITY.md"]) {
  await cp(join(root, file), join(out, file));
}

const pkg = JSON.parse(await readFile(join(out, "package.json"), "utf8"));
console.log(`  staged ${pkg.name}@${pkg.version} in packages/cli`);
await writeFile(join(out, ".npmignore"), "bin/\n");
