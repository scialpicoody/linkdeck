import type { ScriptEntry } from "../components/scripts";
import type { WorkspaceDocument, WorkspaceFile } from "../mygo";

/** One open editor tab. Revisions guard saves against external changes. */
export interface ScriptTab {
  id: string;
  path: string;
  name: string;
  source: string;
  savedSource: string;
  revision: string;
  modifiedMs: number;
}

export function entryFromWorkspaceFile(file: WorkspaceFile): ScriptEntry {
  return {
    id: file.path,
    name: file.name,
    path: file.path,
    origin: "workspace",
  };
}

export function tabFromDocument(doc: WorkspaceDocument): ScriptTab {
  return {
    id: doc.path,
    path: doc.path,
    name: doc.name,
    source: doc.source,
    savedSource: doc.source,
    revision: doc.revision,
    modifiedMs: doc.modifiedMs,
  };
}

export function isScriptDirty(tab: ScriptTab): boolean {
  return tab.source !== tab.savedSource;
}

/** Drop favorites whose file no longer exists in the current workspace. */
export function liveFavorites(favorites: string[], files: WorkspaceFile[]): string[] {
  const live = new Set(files.map((file) => file.path));
  return [...new Set(favorites)].filter((path) => live.has(path));
}

export function nextTabAfterClose(openIds: string[], closingId: string): string | null {
  const index = openIds.indexOf(closingId);
  if (index < 0) return openIds.at(-1) ?? null;
  return openIds[index + 1] ?? openIds[index - 1] ?? null;
}
