import { describe, expect, it } from "vitest";
import { agentConfiguration, localAgentOrigin, sampleTask, sharedAgentOrigin } from "../src/agent-setup.js";
import { resolveLocale } from "../src/i18n.js";

describe("local agent setup", () => {
  it.each(["http://127.0.0.1:4567", "http://localhost:4321", "http://[::1]:5555"])("preserves local origin %s", (origin) => {
    expect(localAgentOrigin(`${origin}/?doc=notes.md`)).toBe(origin);
    expect(agentConfiguration("claude", "posix", origin)).toContain(`--url "${origin}"`);
  });
  it.each(["https://example.com", "http://127.0.0.1.evil.test", "file:///tmp/notes", "javascript:alert(1)",
    "http://user:password@localhost", "http://localhost:4321/?share=secret", "not a url"])("rejects unsafe or shared setup %s", (url) => {
    expect(localAgentOrigin(url)).toBeNull();
    expect(() => agentConfiguration("codex", "posix", url)).toThrow();
  });
  it("generates native Windows commands and parseable Cursor configuration", () => {
    expect(agentConfiguration("codex", "windows", "http://localhost:4321")).toContain("codex mcp add quire -- cmd /c npx");
    const config = JSON.parse(agentConfiguration("cursor", "windows", "http://localhost:4567"));
    expect(config.mcpServers.quire.command).toBe("cmd");
    expect(config.mcpServers.quire.args.slice(0, 2)).toEqual(["/c", "npx"]);
    expect(config.mcpServers.quire.args).toContain("http://localhost:4567");
  });
  it("generates document-scoped setup from a share capability", () => {
    const token = "abcdefghijklmnopqrstuvwx";
    expect(sharedAgentOrigin(`https://quire.example/?share=${token}&doc=plan.md`)).toEqual({
      origin: "https://quire.example", token,
    });
    const command = agentConfiguration("codex", "posix", "https://quire.example", token);
    expect(command).toContain('--url "https://quire.example"');
    expect(command).toContain(`--share ${token}`);
  });
  it.each(["short", "spaces are unsafe", "../../escape", ""])("rejects invalid share token %s", (token) => {
    expect(sharedAgentOrigin(`https://quire.example/?share=${encodeURIComponent(token)}`)).toBeNull();
    expect(() => agentConfiguration("codex", "posix", "https://quire.example", token || undefined)).toThrow();
  });
  it("quotes Unicode document paths as data and asks for a suggestion", () => {
    const path = '计划/草稿 "one".md';
    expect(sampleTask(path)).toContain(JSON.stringify(path));
    expect(sampleTask(path)).toContain("suggest=true");
    expect(sampleTask(path)).toContain("Do not edit files directly");
  });
});

describe("locale preference", () => {
  it.each(["zh", "zh-CN", "zh-SG", "zh-Hans", "zh-Hans-CN"])("recognizes Simplified Chinese %s", (language) => {
    expect(resolveLocale(null, [language])).toBe("zh-CN");
  });
  it.each(["zh-TW", "zh-Hant", "fr", "en-US"])("falls back to English for %s", (language) => {
    expect(resolveLocale("invalid", [language])).toBe("en");
  });
  it("honors explicit preferences ahead of browser language", () => {
    expect(resolveLocale("en", ["zh-CN"])).toBe("en");
    expect(resolveLocale("zh-CN", ["en"])).toBe("zh-CN");
    expect(resolveLocale(null, [])).toBe("en");
  });
});
