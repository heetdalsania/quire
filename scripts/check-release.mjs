import { access, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Refuse to publish something that will not run.
 *
 * The failure this guards against is specific and silent: a published package whose
 * bundled entry point is stale, or whose web client was never copied in. The user finds
 * out when `npx quire` exits with "Web client not found", which is the worst possible
 * first impression.
 */
const cli = join(dirname(fileURLToPath(import.meta.url)), "../packages/cli");
const problems = [];

const exists = async (p) => access(join(cli, p)).then(() => true).catch(() => false);

for (const required of ["dist/quire.js", "dist/quire-mcp.js", "web/index.html", "registry/index.json", "LICENSE"]) {
  if (!(await exists(required))) problems.push(`missing ${required} — run: npm run build:release`);
}

if (await exists("web/assets")) {
  const assets = await readdir(join(cli, "web/assets"));
  if (!assets.some((f) => f.endsWith(".js"))) problems.push("web/assets contains no JavaScript");
} else {
  problems.push("missing web/assets — the client was not built");
}

for (const entry of ["dist/quire.js", "dist/quire-mcp.js"]) {
  if (!(await exists(entry))) continue;
  const body = await readFile(join(cli, entry), "utf8");
  const shebangs = (body.match(/^#!/gm) ?? []).length;
  // A second shebang lands mid-file and is a syntax error the moment anyone runs it.
  if (shebangs !== 1) problems.push(`${entry} has ${shebangs} shebangs, expected exactly 1`);
  if (!body.startsWith("#!")) problems.push(`${entry} does not start with a shebang`);
}

const pkg = JSON.parse(await readFile(join(cli, "package.json"), "utf8"));
const expectedLicense = "AGPL-3.0-or-later";
const expectedBins = { quire: "dist/quire.js", "quire-mcp": "dist/quire-mcp.js" };
const forbiddenInstallScripts = ["preinstall", "install", "postinstall"];

// The bundles must actually start. Nothing else here proves that.
for (const entry of ["dist/quire.js", "dist/quire-mcp.js"]) {
  if (!(await exists(entry))) continue;
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  try {
    await promisify(execFile)(process.execPath, [join(cli, entry), "--help"], { timeout: 20_000 });
  } catch (error) {
    const detail = String(error.stderr || error.message).split("\n")[0];
    problems.push(`${entry} fails to run: ${detail}`);
  }
}
if (pkg.private) problems.push("package is marked private");
if (!pkg.version || pkg.version === "0.0.0") problems.push("version is unset");
if (pkg.license !== expectedLicense) {
  problems.push(`package license is ${pkg.license ?? "unset"}, expected ${expectedLicense}`);
}
for (const [name, target] of Object.entries(expectedBins)) {
  if (pkg.bin?.[name] !== target) {
    problems.push(`package bin.${name} is ${pkg.bin?.[name] ?? "unset"}, expected ${target}`);
  }
}
for (const entry of ["dist/quire.js", "dist/quire-mcp.js"]) {
  if (!(await exists(entry))) continue;
  const mode = (await stat(join(cli, entry))).mode;
  if ((mode & 0o111) === 0) problems.push(`${entry} is not executable`);
}
if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
  // Workspace ranges like "*" do not resolve for anyone outside this repository.
  problems.push(`unbundled dependencies would not resolve: ${Object.keys(pkg.dependencies).join(", ")}`);
}
for (const script of forbiddenInstallScripts) {
  if (pkg.scripts?.[script]) problems.push(`package must not define an install-time ${script} script`);
}

for (const entry of ["dist/quire.js", "dist/quire-mcp.js"]) {
  if (!(await exists(entry))) continue;
  const body = await readFile(join(cli, entry), "utf8");
  if (body.includes("GITHUB_TOKEN")) {
    problems.push(`${entry} reads GITHUB_TOKEN; published Quire must not forward ambient credentials`);
  }
}

if (await exists("dist/quire.js")) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [join(cli, "dist/quire.js"), "--version"], {
      timeout: 20_000,
    });
    if (stdout.trim() !== pkg.version) {
      problems.push(`quire --version returned ${JSON.stringify(stdout.trim())}, expected ${pkg.version}`);
    }
  } catch (error) {
    const detail = String(error.stderr || error.message).split("\n")[0];
    problems.push(`quire --version fails: ${detail}`);
  }
}

if (problems.length > 0) {
  console.error("Refusing to publish:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(`quire@${pkg.version} looks publishable.`);
