import { copyToClipboard } from "./export.js";
import { t } from "./i18n.js";

export type AgentClient = "claude" | "codex" | "cursor";
export type AgentPlatform = "posix" | "windows";
export interface SharedAgentOrigin { origin: string; token: string }
export type AgentAccess =
  | { state: "ready"; role: "edit" | "comment" | "view" | "owner"; scope: string | null }
  | { state: "expired" | "wrong-scope" | "unavailable" };
const isLoopback = (hostname: string): boolean => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);

export function localAgentOrigin(href: string): string | null {
  try {
    const url = new URL(href);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.searchParams.has("share") || !isLoopback(url.hostname)) return null;
    return url.origin;
  } catch { return null; }
}

export function sharedAgentOrigin(href: string): SharedAgentOrigin | null {
  try {
    const url = new URL(href);
    const token = url.searchParams.get("share") ?? "";
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        (url.protocol === "http:" && !isLoopback(url.hostname)) ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
    return { origin: url.origin, token };
  } catch { return null; }
}

export function agentConfiguration(client: AgentClient, platform: AgentPlatform, origin: string, shareToken?: string): string {
  const shared = shareToken ? sharedAgentOrigin(`${origin}/?share=${encodeURIComponent(shareToken)}`) : null;
  const safeOrigin = shared?.origin ?? localAgentOrigin(origin);
  if (!safeOrigin) throw new Error("Localhost or shared session required");
  const name = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" }[client];
  const args = ["-y", "-p", "quiredocs@latest", "quire-mcp", "--url", safeOrigin, "--name", name];
  if (shared) args.push("--share", shared.token);
  if (client === "cursor") return JSON.stringify({ mcpServers: { quire: {
    command: platform === "windows" ? "cmd" : "npx",
    args: platform === "windows" ? ["/c", "npx", ...args] : args,
  } } }, null, 2);
  // All variable command fields are validated origins or closed-set client names.
  return `${client} mcp add quire -- ${platform === "windows" ? "cmd /c " : ""}npx -y -p quiredocs@latest quire-mcp --url "${safeOrigin}" --name "${name}"${shared ? ` --share ${shared.token}` : ""}`;
}

export function sampleTask(path: string): string {
  return `Using Quire MCP, read the document at path ${JSON.stringify(path)} and propose one small clarity improvement with edit_document and suggest=true. Do not edit files directly or accept the suggestion. Leave the final decision to me.`;
}

export async function checkAgentAccess(
  href: string, path: string | null,
  request: typeof fetch = fetch,
): Promise<AgentAccess> {
  const shared = sharedAgentOrigin(href);
  if (!shared && !localAgentOrigin(href)) return { state: "unavailable" };
  try {
    let role: "edit" | "comment" | "view" | "owner" = "owner";
    let scope: string | null = null;
    if (shared) {
      const info = await request(`/api/share/info?token=${encodeURIComponent(shared.token)}`, { cache: "no-store" });
      if (info.status === 404) return { state: "expired" };
      if (!info.ok) return { state: "unavailable" };
      const data: unknown = await info.json();
      if (!data || typeof data !== "object" || !("role" in data) ||
          !["edit", "comment", "view"].includes(String(data.role)) ||
          !("path" in data) || (data.path !== null && typeof data.path !== "string")) {
        return { state: "unavailable" };
      }
      role = data.role as "edit" | "comment" | "view";
      scope = data.path as string | null;
    }
    const files = await request(`/api/files${shared ? `?share=${encodeURIComponent(shared.token)}` : ""}`, { cache: "no-store" });
    if (!files.ok) return { state: files.status === 403 ? "expired" : "unavailable" };
    const data: unknown = await files.json();
    if (!data || typeof data !== "object" || !("files" in data) || !Array.isArray(data.files)) {
      return { state: "unavailable" };
    }
    if (path && !data.files.includes(path)) return { state: "wrong-scope" };
    return { state: "ready", role, scope };
  } catch { return { state: "unavailable" }; }
}

export function wireAgentSetup(button: HTMLButtonElement, state: () => {
  path: string | null; connected: boolean; agents: string[];
}): { refresh: () => void } {
  let dialog: HTMLDialogElement | null = null;
  let client: AgentClient = "claude";
  let platform: AgentPlatform = /Win/i.test(navigator.platform) ? "windows" : "posix";
  let status: HTMLElement | null = null;
  let accessStatus: HTMLElement | null = null;
  let checkAccess: HTMLButtonElement | null = null;
  let copyConfig: HTMLButtonElement | null = null;
  let task: HTMLTextAreaElement | null = null;
  let copyTask: HTMLButtonElement | null = null;
  let checkedPath: string | null = null;
  let access: AgentAccess | null = null;
  const refresh = (): void => {
    const now = state();
    if (checkedPath !== now.path) {
      checkedPath = now.path;
      access = null;
    }
    button.hidden = now.connected && now.agents.length > 0;
    button.textContent = t("Connect agent");
    if (status) status.textContent = !now.path ? t("No document selected") : !now.connected ? t("Connection unavailable") :
      now.agents.length ? `${t("Agent connected")}: ${now.agents.join(", ")}` : t("No agent in this document");
    if (accessStatus) {
      const label = access?.state === "ready" ?
        `${t("Link verified")}: ${t(access.role === "owner" ? "Local owner" : access.role === "edit" ? "Edit access" : access.role === "comment" ? "Comment access" : "View access")}${access.scope ? ` (${access.scope})` : ""}` :
        t(access?.state === "expired" ? "Link expired or revoked" : access?.state === "wrong-scope" ?
          "Link does not include this document" : access?.state === "unavailable" ? "Link check failed" : "Link not checked");
      accessStatus.textContent = label;
    }
    if (task) task.value = now.path && access?.state === "ready" ?
      access.role === "edit" || access.role === "owner" ? sampleTask(now.path) :
        `Using Quire MCP, read the document at path ${JSON.stringify(now.path)} and summarize it. Do not edit the document.` : "";
    if (copyConfig) copyConfig.disabled = access?.state !== "ready";
    if (copyTask) copyTask.disabled = !now.path || !now.connected || access?.state !== "ready";
  };
  const show = (): void => {
    checkedPath = null;
    access = null;
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
    dialog.onclose = () => {
      dialog?.remove(); dialog = null; status = null; accessStatus = null;
      checkAccess = null; copyConfig = null; task = null; copyTask = null;
      if (button.hidden) document.querySelector<HTMLElement>("#search")?.focus();
      else button.focus();
    };
    const shared = sharedAgentOrigin(location.href);
    const origin = localAgentOrigin(location.href) ?? shared?.origin ?? null;
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
      const updateConfig = (): void => { config.value = agentConfiguration(client, platform, origin, shared?.token); };
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
      copyConfig = copy("Copy configuration", () => config.value);
      checkAccess = document.createElement("button");
      checkAccess.textContent = t("Check link");
      checkAccess.onclick = async () => {
        const path = state().path;
        checkAccess!.disabled = true;
        accessStatus!.textContent = t("Checking link");
        const result = await checkAgentAccess(location.href, path);
        if (state().path === path && dialog?.open) access = result;
        refresh();
      };
      dialog.append(checkAccess);
      accessStatus = document.createElement("p");
      accessStatus.id = "agent-access-status";
      accessStatus.setAttribute("role", "status");
      dialog.append(accessStatus);
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
      checkAccess.click();
    }
    document.body.append(dialog);
    dialog.showModal();
  };
  button.onclick = show;
  window.addEventListener("quire:locale", () => { refresh(); if (dialog) show(); });
  return { refresh };
}
