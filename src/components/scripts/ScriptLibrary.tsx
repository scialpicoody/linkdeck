import { useEffect, useMemo, useState } from "react";
import type { ScriptEntry } from "./types";

export interface ScriptLibraryProps {
  /** Static entries from the workspace-directory scan (Go-owned later). */
  workspaceScripts: ScriptEntry[];
  /** Favorite script ids used before the loader resolves (yaml-backed later). */
  initialFavorites?: string[];
  /** Load stub: returns persisted favorite ids (sync or async). */
  onLoadFavorites?: () => string[] | Promise<string[]>;
  /** Save stub: receives favorite ids; yaml wiring lands later. */
  onSaveFavorites?: (ids: string[]) => void;
  /** Currently open script id. */
  selectedId?: string | null;
  /** User picked a script (opens it in the editor; layout-owned). */
  onSelect?: (script: ScriptEntry) => void;
  /** One-click run stub; the Go scripting engine lands later. */
  onRun?: (script: ScriptEntry) => void;
}

function Star({ filled }: { filled: boolean }) {
  return (
    <span aria-hidden="true" className={filled ? "text-primary" : "text-muted-foreground"}>
      {filled ? "★" : "☆"}
    </span>
  );
}

export default function ScriptLibrary({
  workspaceScripts,
  initialFavorites = [],
  onLoadFavorites,
  onSaveFavorites,
  selectedId = null,
  onSelect,
  onRun,
}: ScriptLibraryProps) {
  // Favorites are local-state only for now; the load/save prop pair is the
  // seam the later yaml wiring will plug into without touching this panel.
  const [favorites, setFavorites] = useState<string[]>(initialFavorites);
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);

  useEffect(() => {
    if (!onLoadFavorites) return;
    let cancelled = false;
    const loaded = onLoadFavorites();
    if (loaded instanceof Promise) {
      loaded.then((ids) => {
        if (!cancelled) setFavorites(ids);
      });
    } else {
      setFavorites(loaded);
    }
    return () => {
      cancelled = true;
    };
  }, [onLoadFavorites]);

  function toggleFavorite(id: string) {
    setFavorites((prev) => {
      const next = prev.includes(id)
        ? prev.filter((f) => f !== id)
        : [...prev, id];
      onSaveFavorites?.(next);
      return next;
    });
  }

  const favoriteEntries = useMemo(
    () =>
      workspaceScripts
        .filter((s) => favoriteSet.has(s.id))
        .map((s) => ({ ...s, origin: "favorite" as const })),
    [workspaceScripts, favoriteSet],
  );

  function row(script: ScriptEntry, isFavorite: boolean) {
    const selected = script.id === selectedId;
    return (
      <li key={script.id}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => onSelect?.(script)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelect?.(script);
            }
          }}
          className={`flex w-full items-center gap-2 rounded-[var(--radius)] border px-2.5 py-2 text-left text-sm ${
            selected
              ? "border-ring bg-accent text-accent-foreground"
              : "border-border bg-card text-card-foreground hover:bg-muted"
          }`}
        >
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{script.name}</div>
            <div className="truncate font-mono text-xs text-muted-foreground">
              {script.path}
            </div>
          </div>
          <button
            type="button"
            title={isFavorite ? "Remove from favorites" : "Add to favorites"}
            aria-label={isFavorite ? `Unfavorite ${script.name}` : `Favorite ${script.name}`}
            aria-pressed={isFavorite}
            onClick={(e) => {
              e.stopPropagation();
              toggleFavorite(script.id);
            }}
            className="rounded px-1 text-base leading-none hover:bg-muted"
          >
            <Star filled={isFavorite} />
          </button>
          <button
            type="button"
            title={`Run ${script.name}`}
            aria-label={`Run ${script.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onRun?.(script);
            }}
            className="min-h-8 rounded-[var(--radius)] bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
          >
            Run
          </button>
        </div>
      </li>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-3">
      {favoriteEntries.length > 0 && (
        <section aria-label="Favorite scripts">
          <h2 className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Favorites
          </h2>
          <ul className="flex flex-col gap-1.5">
            {favoriteEntries.map((s) => row(s, true))}
          </ul>
        </section>
      )}
      <section aria-label="Workspace scripts" className="flex-1">
        <h2 className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Workspace
        </h2>
        {workspaceScripts.length === 0 ? (
          <p className="rounded-[var(--radius)] border border-dashed border-border p-3 text-sm text-muted-foreground">
            No scripts in the workspace directory yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {workspaceScripts.map((s) => row(s, favoriteSet.has(s.id)))}
          </ul>
        )}
      </section>
    </div>
  );
}
