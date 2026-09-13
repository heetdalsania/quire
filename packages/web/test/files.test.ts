import { describe, expect, it } from "vitest";
import { fileTree, matchingFiles } from "../src/files.js";

describe("file navigation", () => {
  it("groups folders first, sorts numerically, and keeps duplicate basenames distinct", () => {
    const tree = fileTree(["z.md", "Session 10/Agenda.md", "Session 2/Agenda.md", "a.md", "Session 2/Agenda.md"]);
    expect(tree.map((n) => n.name)).toEqual(["Session 2", "Session 10", "a.md", "z.md"]);
    expect(tree[0]!.children).toEqual([{ name: "Agenda.md", path: "Session 2/Agenda.md" }]);
    expect(tree[1]!.children![0]!.path).toBe("Session 10/Agenda.md");
  });
  it("handles nested folders, special characters, and names matching Object properties", () => {
    expect(fileTree(["__proto__/constructor/a <b>.md"])).toEqual([
      { name: "__proto__", path: "__proto__", children: [
        { name: "constructor", path: "__proto__/constructor", children: [
          { name: "a <b>.md", path: "__proto__/constructor/a <b>.md" },
        ] },
      ] },
    ]);
  });
  it("combines case-insensitive path matches with content hits without duplicates or stale paths", () => {
    expect(matchingFiles(["Workshop/Agenda.md", "home.md"], "AGENDA", ["home.md", "Workshop/Agenda.md", "deleted.md"]))
      .toEqual(["Workshop/Agenda.md", "home.md"]);
    expect(matchingFiles(["Workshop/Agenda.md"], "workshop/", [])).toEqual(["Workshop/Agenda.md"]);
  });
});
