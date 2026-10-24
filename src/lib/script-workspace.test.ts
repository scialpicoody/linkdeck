import { describe, expect, it } from "vitest";
import type { WorkspaceDocument, WorkspaceFile } from "../mygo";
import {
  entryFromWorkspaceFile,
  isScriptDirty,
  liveFavorites,
  nextTabAfterClose,
  tabFromDocument,
} from "./script-workspace";

function file(path: string): WorkspaceFile {
  return { path, name: path.split("/").at(-1) ?? path, size: 10, modifiedMs: 1 };
}

function doc(path: string): WorkspaceDocument {
  return {
    path,
    name: path,
    source: "return 1\n",
    size: 9,
    modifiedMs: 1,
    revision: "rev-1",
  };
}

describe("script workspace state", () => {
  it("maps workspace files to stable path ids", () => {
    expect(entryFromWorkspaceFile(file("bench/at.lua"))).toEqual({
      id: "bench/at.lua",
      name: "at.lua",
      path: "bench/at.lua",
      origin: "workspace",
    });
  });

  it("tracks dirty source independently from the saved revision", () => {
    const tab = tabFromDocument(doc("probe.lua"));
    expect(isScriptDirty(tab)).toBe(false);
    expect(isScriptDirty({ ...tab, source: `${tab.source}log("x")\n"` })).toBe(true);
  });

  it("drops stale and duplicate favorites after a workspace refresh", () => {
    expect(
      liveFavorites(["b.lua", "gone.lua", "a.lua", "a.lua"], [file("a.lua"), file("b.lua")]),
    ).toEqual(["b.lua", "a.lua"]);
  });

  it("chooses a deterministic adjacent tab when closing the active one", () => {
    expect(nextTabAfterClose(["a.lua", "b.lua", "c.lua"], "b.lua")).toBe("c.lua");
    expect(nextTabAfterClose(["a.lua", "b.lua"], "b.lua")).toBe("a.lua");
    expect(nextTabAfterClose([], "a.lua")).toBeNull();
  });
});
