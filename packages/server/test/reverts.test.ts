import { describe, expect, it } from "vitest";
import { DocHandle } from "@quire/bridge";
import { ATTR_AUTHOR, ATTR_SUGGEST_INSERT } from "@quire/bridge";
import { listReverts, restoreAgentEdits, revertAgentEdits } from "../src/reverts.js";

function document(): DocHandle {
  const handle = new DocHandle("doc.md");
  handle.text.insert(0, "Human ");
  handle.text.insert(6, "first", { [ATTR_AUTHOR]: "agent-1" });
  handle.text.insert(11, " + ", {});
  handle.text.insert(14, "second", { [ATTR_AUTHOR]: "agent-1" });
  handle.text.insert(20, " end", {});
  return handle;
}

describe("agent edit revert", () => {
  it("restores adjacent attributed spans in their original order after other edits", () => {
    const handle = document();
    const original = handle.text.toString();
    const record = revertAgentEdits(handle, "agent-1", "Agent", "Heet");
    expect(handle.text.toString()).toBe("Human  +  end");
    expect(listReverts(handle)[0]).toMatchObject({ id: record.id, revertedBy: "Heet", restoredAt: null });
    handle.text.insert(0, "New ");
    const restored = restoreAgentEdits(handle, record.id, "Arun");
    expect(handle.text.toString()).toBe(`New ${original}`);
    expect(restored).toMatchObject({ restoredBy: "Arun", chars: 11 });
    expect(() => restoreAgentEdits(handle, record.id, "Again")).toThrow(/already been restored/);
  });

  it("leaves pending suggestions untouched and refuses protected log spans", () => {
    const handle = new DocHandle("log.md");
    handle.text.insert(0, "task ");
    handle.text.insert(5, "edit", { [ATTR_AUTHOR]: "agent-1" });
    handle.text.insert(9, "\n## Iteration log\n", {});
    const protectedStart = handle.text.toString().indexOf("## Iteration log");
    handle.text.insert(handle.text.length, "old", { [ATTR_AUTHOR]: "agent-1" });
    handle.text.insert(handle.text.length, "pending", { [ATTR_AUTHOR]: "agent-1", [ATTR_SUGGEST_INSERT]: "suggestion" });
    const record = revertAgentEdits(handle, "agent-1", "Agent", "Heet", protectedStart);
    expect(handle.text.toString()).toContain("oldpending");
    expect(handle.text.toString()).not.toContain("task edit");
    restoreAgentEdits(handle, record.id, "Heet", protectedStart);
    expect(handle.text.toString()).toContain("task edit");
  });

  it("restores adjacent spans with different attributes in order", () => {
    const handle = new DocHandle("adjacent.md");
    handle.text.insert(0, "A", {});
    handle.text.insert(1, "one", { [ATTR_AUTHOR]: "agent-1", color: "red" });
    handle.text.insert(4, "two", { [ATTR_AUTHOR]: "agent-1", color: "blue" });
    handle.text.insert(7, "Z", {});
    const record = revertAgentEdits(handle, "agent-1", "Agent", "Heet");
    expect(handle.text.toString()).toBe("AZ");
    restoreAgentEdits(handle, record.id, "Heet");
    expect(handle.text.toString()).toBe("AonetwoZ");
    expect(handle.text.toDelta()).toEqual([
      { insert: "A" },
      { insert: "one", attributes: { [ATTR_AUTHOR]: "agent-1", color: "red" } },
      { insert: "two", attributes: { [ATTR_AUTHOR]: "agent-1", color: "blue" } },
      { insert: "Z" },
    ]);
  });
});
