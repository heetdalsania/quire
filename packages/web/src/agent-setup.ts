import { copyToClipboard } from "./export.js";
import { t } from "./i18n.js";

export type AgentClient = "claude" | "codex" | "cursor";
export type AgentPlatform = "posix" | "windows";

export function localAgentOrigin(href: string): string | null {
  try {
    const url = new URL(href);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.searchParams.has("share") || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
    return url.origin;
  } catch { return null; }
}

export function agentConfiguration(client: AgentClient, platform: AgentPlatform, origin: string): string {
  const safeOrigin = localAgentOrigin(origin);
  if (!safeOrigin) throw new Error("Localhost session required");
  const name = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" }[client];
  const args = ["-y", "-p", "quiredocs@latest", "quire-mcp", "--url", safeOrigin, "--name", name];
  if (client === "cursor") return JSON.stringify({ mcpServers: { quire: {
    command: platform === "windows" ? "cmd" : "npx",
    args: platform === "windows" ? ["/c", "npx", ...args] : args,
  } } }, null, 2);
  // All variable command fields are validated origins or closed-set client names.
  return `${client} mcp add quire -- ${platform === "windows" ? "cmd /c " : ""}npx -y -p quiredocs@latest quire-mcp --url "${safeOrigin}" --name "${name}"`;
}

export function sampleTask(path: string): string {
  return `Using Quire MCP, read the document at path ${JSON.stringify(path)} and propose one small clarity improvement with edit_document and suggest=true. Do not edit files directly or accept the suggestion. Leave the final decision to me.`;
}

export function wireAgentSetup(button: HTMLButtonElement, state: () => {
  path: string | null; connected: boolean; agents: string[];
}): { refresh: () => void } {
  let dialog: HTMLDialogElement | null = null;
  let client: AgentClient = "claude";
  let platform: AgentPlatform = /Win/i.test(navigator.platform) ? "windows" : "posix";
  let status: HTMLElement | null = null;
  let task: HTMLTextAreaElement | null = null;
  let copyTask: HTMLButtonElement | null = null;
  const refresh = (): void => {
    const now = state();
    if (status) status.textContent = !now.path ? t("No document selected") : !now.connected ? t("Connection unavailable") :
      now.agents.length ? `${t("Agent connected")}: ${now.agents.join(", ")}` : t("No agent in this document");
    if (task) task.value = now.path ? sampleTask(now.path) : "";
    if (copyTask) copyTask.disabled = !now.path || !now.connected;
  };
  const show = (): void => {
    dialog?.remove();
    dialog = document.createElement("dialog");
    dialog.id = "agent-setup";
    dialog.setAttribute("aria-labelledby", "agent-setup-title");
    const title = document.createElement("h2");
    title.id = "agent-setup-title";
    title.textContent = t("Connect agent");
    const close = document.createElement("button");
    close.className = "agent-close";
    close.textContent = "\u00d7";
    close.setAttribute("aria-label", t("Close"));
    close.title = t("Close");
    close.onclick = () => dialog?.close();
    dialog.append(title, close);
    dialog.onclose = () => { dialog?.remove(); dialog = null; status = null; task = null; copyTask = null; button.focus(); };
    const origin = localAgentOrigin(location.href);
    if (!origin) {
      const message = document.createElement("p");
      message.textContent = t("Localhost session required");
      dialog.append(message);
    } else {
      const field = (label: string, control: HTMLElement): void => {
        control.setAttribute("aria-label", t(label));
        const wrapper = document.createElement("label");
        const text = document.createElement("span");
        text.textContent = t(label);
        wrapper.append(text, control);
        dialog!.append(wrapper);
      };
      const select = <T extends string>(values: Array<[T, string]>, value: T, change: (next: T) => void): HTMLSelectElement => {
        const el = document.createElement("select");
        for (const [key, label] of values) el.add(new Option(label, key));
        el.value = value;
        el.onchange = () => change(el.value as T);
        return el;
      };
      const config = document.createElement("textarea");
      config.readOnly = true;
      config.spellcheck = false;
      const updateConfig = (): void => { config.value = agentConfiguration(client, platform, origin); };
      field("Client", select<AgentClient>([["claude", "Claude Code"], ["codex", "Codex"], ["cursor", "Cursor (.cursor/mcp.json)"]], client, (value) => { client = value; updateConfig(); }));
      field("Platform", select<AgentPlatform>([["posix", "macOS / Linux / WSL"], ["windows", "Windows"]], platform, (value) => { platform = value; updateConfig(); }));
      field("Configuration", config);
      const copy = (label: string, value: () => string): HTMLButtonElement => {
        const el = document.createElement("button");
        el.textContent = t(label);
        el.onclick = async () => {
          try { await copyToClipboard(value()); el.textContent = t("Copied"); }
          catch { el.textContent = t("Copy failed"); }
          setTimeout(() => { el.textContent = t(label); }, 2000);
        };
        dialog!.append(el);
        return el;
      };
      copy("Copy configuration", () => config.value);
      status = document.createElement("p");
      status.id = "agent-connection-status";
      status.setAttribute("role", "status");
      dialog.append(status);
      task = document.createElement("textarea");
      task.readOnly = true;
      field("Sample task", task);
      copyTask = copy("Copy task", () => task?.value ?? "");
      updateConfig();
      refresh();
    }
    document.body.append(dialog);
    dialog.showModal();
  };
  button.onclick = show;
  window.addEventListener("quire:locale", () => { if (dialog) show(); });
  return { refresh };
}
