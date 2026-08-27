import { spawn } from "node:child_process";

/**
 * Running a fenced code block, and capturing what it printed back into the document.
 *
 * A runbook that has actually been run, with real output recorded beside each step, is
 * worth ten that have not. That is the entire argument for this feature, and it has to be
 * weighed against the obvious: this executes arbitrary code on the machine hosting the
 * vault.
 *
 * The safeguards are therefore not decoration:
 *
 *  - **Off unless asked for.** Requires `--allow-exec`. There is no configuration file
 *    that can turn it on by accident.
 *  - **Loopback only.** Refused outright when the server is bound beyond localhost.
 *    Quire has no authentication, so an exposed server with execution enabled would hand
 *    a shell to anyone who could reach the port.
 *  - **Never automatic.** Blocks run only when a person asks for that specific block.
 *    Opening a document runs nothing, which means a malicious document installed from
 *    Discover cannot execute itself.
 *  - **Bounded.** Wall-clock timeout, output cap, killed process group on expiry.
 */

export interface ExecOptions {
  enabled: boolean;
  /** True when the server is reachable from beyond this machine. */
  exposed: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  cwd: string;
}

export interface ExecResult {
  ok: boolean;
  language: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
}

/** Interpreters we are prepared to hand a block to. Anything else is refused by name. */
const RUNNERS: Record<string, { command: string; args: string[] }> = {
  bash: { command: "bash", args: ["-c"] },
  sh: { command: "sh", args: ["-c"] },
  shell: { command: "sh", args: ["-c"] },
  zsh: { command: "zsh", args: ["-c"] },
  python: { command: "python3", args: ["-c"] },
  python3: { command: "python3", args: ["-c"] },
  node: { command: "node", args: ["-e"] },
  javascript: { command: "node", args: ["-e"] },
};

export const supportedLanguages = (): string[] => Object.keys(RUNNERS);

export class ExecRefused extends Error {}

export async function runBlock(
  language: string,
  source: string,
  options: ExecOptions,
): Promise<ExecResult> {
  if (!options.enabled) {
    throw new ExecRefused("Execution is disabled. Restart with --allow-exec to enable it.");
  }
  if (options.exposed) {
    throw new ExecRefused(
      "Execution is refused while the server is reachable beyond localhost. Quire has no " +
        "authentication, so this would hand a shell to anyone who can reach the port.",
    );
  }

  const runner = RUNNERS[language.toLowerCase()];
  if (!runner) {
    throw new ExecRefused(
      `No runner for "${language}". Supported: ${supportedLanguages().join(", ")}.`,
    );
  }
  if (source.length > 100_000) throw new ExecRefused("Block is too large to run.");

  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxOutputBytes ?? 256 * 1024;
  const started = Date.now();

  return new Promise<ExecResult>((resolve) => {
    const child = spawn(runner.command, [...runner.args, source], {
      cwd: options.cwd,
      // Its own process group, so a timeout can take the whole tree rather than leaving
      // orphaned children behind.
      detached: true,
      env: { ...process.env, QUIRE_EXEC: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;

    const collect = (chunk: Buffer, into: "out" | "err"): void => {
      const text = chunk.toString("utf8");
      if (into === "out") {
        if (stdout.length + text.length > maxBytes) truncated = true;
        stdout = (stdout + text).slice(0, maxBytes);
      } else {
        if (stderr.length + text.length > maxBytes) truncated = true;
        stderr = (stderr + text).slice(0, maxBytes);
      }
    };
    child.stdout.on("data", (c: Buffer) => collect(c, "out"));
    child.stderr.on("data", (c: Buffer) => collect(c, "err"));

    const finish = (exitCode: number | null, note?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: exitCode === 0,
        language,
        stdout,
        stderr: note ? `${stderr}${note}` : stderr,
        exitCode,
        durationMs: Date.now() - started,
        truncated,
      });
    };

    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish(null, `\n[quire] killed after ${timeoutMs}ms`);
    }, timeoutMs);

    child.on("error", (error) => finish(null, `\n[quire] ${error.message}`));
    child.on("close", (code) => finish(code));
  });
}

/** Render a result as the Markdown block written back beneath the source. */
export function formatResult(result: ExecResult): string {
  const body = [result.stdout, result.stderr].filter((s) => s.trim()).join("\n").trimEnd();
  const status = result.exitCode === 0 ? "ok" : `exit ${result.exitCode ?? "killed"}`;
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  return [
    "",
    `<!-- quire:output ${stamp} ${status} ${result.durationMs}ms -->`,
    "```text",
    body || "(no output)",
    result.truncated ? "[output truncated]" : "",
    "```",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
