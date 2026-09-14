import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { QuireServer } from "../../packages/server/dist/src/index.js";

const root = await mkdtemp(join(tmpdir(), "quire-recording-"));
let server;
try {
  await mkdir(join(root, "Workshop"));
  await writeFile(join(root, "spec.md"), "# Payments API\n\nA short specification for the charges service.\n\n## Overview\n\nThe service handles charges.\nIt sits between the storefront and the ledger, and is the only component permitted to move money.\n\n## Errors\n\nErrors are returned as JSON.\n\nSee [[notes]] for background.\n");
  await writeFile(join(root, "notes.md"), "# Notes\n\nKeep the specification small and review every change.\n");
  await writeFile(join(root, "Workshop", "agenda.md"), "# Workshop agenda\n\n- [ ] Open a shared document\n- [ ] Review an agent suggestion\n- [ ] Leave a comment\n");
  server = await QuireServer.start({ root, port: 0, git: false, history: true, persist: false,
    webRoot: fileURLToPath(new URL("../../packages/web/dist", import.meta.url)) });
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("record.mjs", import.meta.url))], {
      stdio: "inherit", env: { ...process.env, QUIRE_URL: `http://127.0.0.1:${server.port}` },
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Recorder exited ${code}`)));
  });
} finally {
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
