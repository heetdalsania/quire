import { describe, expect, it } from "vitest";
import { agentConfiguration, localAgentOrigin, sampleTask } from "../src/agent-setup.js";
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
