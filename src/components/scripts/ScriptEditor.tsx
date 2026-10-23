import { useEffect, useRef, useState } from "react";
import type * as monaco from "monaco-editor";
import { LUA_SNIPPETS } from "./snippets";

export interface ScriptEditorProps {
  /** Current Lua source. */
  value: string;
  /** Fired on every edit (layout owns persistence). */
  onChange?: (value: string) => void;
  /**
   * 1-based error line to jump to. When set/changed the editor reveals and
   * selects the line; runtime errors carry line numbers per spec #9.
   */
  errorLine?: number | null;
  /**
   * Error-line jump stub: fired when the editor performs a jump, so the
   * layout can keep output linkage in sync. No static lint in v1.
   */
  onErrorLine?: (line: number) => void;
  readOnly?: boolean;
}

type LoadState = "loading" | "ready" | "failed";

let snippetsRegistered = false;

/**
 * Monaco Lua editor, lazy-loaded per docs/research/frontend-stack.md: the
 * `monaco-editor` ESM chunk (~2.5 MB core) loads only when this component
 * mounts, via dynamic `import()`. Lua is a built-in basic language, so the
 * only worker mapped is `editor.worker` — no TS/CSS/HTML workers.
 */
export default function ScriptEditor({
  value,
  onChange,
  errorLine = null,
  onErrorLine,
  readOnly = false,
}: ScriptEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onErrorLineRef = useRef(onErrorLine);
  onErrorLineRef.current = onErrorLine;
  const [state, setState] = useState<LoadState>("loading");

  useEffect(() => {
    let cancelled = false;
    let editor: monaco.editor.IStandaloneCodeEditor | null = null;
    let model: monaco.editor.ITextModel | null = null;
    let snippetDisposable: monaco.IDisposable | null = null;
    let changeDisposable: monaco.IDisposable | null = null;
    (async () => {
      try {
        // Dynamic import is the point: a static import would put the ~2.5 MB
        // core in the initial chunk (loading-boundary exception, see above).
        // Worker first so MonacoEnvironment exists before the editor loads.
        const { default: editorWorker } = await import(
          "monaco-editor/esm/vs/editor/editor.worker?worker"
        );
        self.MonacoEnvironment = {
          getWorker: () => new editorWorker(),
        };
        const monacoApi = await import("monaco-editor");
        if (cancelled || !hostRef.current) return;

        if (!snippetsRegistered) {
          snippetDisposable = monacoApi.languages.registerCompletionItemProvider(
            "lua",
            {
              triggerCharacters: [".", ":"],
              provideCompletionItems: (model, position) => {
                const word = model.getWordUntilPosition(position);
                const range = {
                  startLineNumber: position.lineNumber,
                  endLineNumber: position.lineNumber,
                  startColumn: word.startColumn,
                  endColumn: word.endColumn,
                };
                return {
                  suggestions: LUA_SNIPPETS.map((s) => ({
                    label: s.label,
                    kind: monacoApi.languages.CompletionItemKind.Snippet,
                    detail: s.detail,
                    insertText: s.body,
                    insertTextRules:
                      monacoApi.languages.CompletionItemInsertTextRule
                        .InsertAsSnippet,
                    range,
                  })),
                };
              },
            },
          );
          snippetsRegistered = true;
        }

        model = monacoApi.editor.createModel(value, "lua");
        editor = monacoApi.editor.create(hostRef.current, {
          model,
          language: "lua",
          readOnly,
          minimap: { enabled: false },
          automaticLayout: true,
        });
        editorRef.current = editor;
        changeDisposable = model.onDidChangeContent(() => {
          onChangeRef.current?.(model?.getValue() ?? "");
        });
        setState("ready");
      } catch {
        if (!cancelled) setState("failed");
      }
    })();

    return () => {
      cancelled = true;
      editorRef.current = null;
      changeDisposable?.dispose();
      editor?.dispose();
      model?.dispose();
      // snippetDisposable is intentionally kept: provider registration is
      // process-wide and guarded by snippetsRegistered.
      void snippetDisposable;
    };
    // Mount-once: value/readOnly flow through the model/options refs below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push external value changes (script switching) into the model.
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model && model.getValue() !== value) model.setValue(value);
  }, [value]);

  // Error-line jump: reveal + select the line, then notify the stub.
  useEffect(() => {
    if (errorLine == null || state !== "ready") return;
    const editor = editorRef.current;
    if (!editor) return;
    const lineCount = editor.getModel()?.getLineCount() ?? 0;
    const line = Math.min(Math.max(1, Math.floor(errorLine)), Math.max(1, lineCount));
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
    onErrorLineRef.current?.(line);
  }, [errorLine, state]);

  if (state === "failed") {
    return (
      <div className="grid h-full place-items-center bg-card p-4 text-sm text-muted-foreground">
        The code editor failed to load. Script output and the library still work.
      </div>
    );
  }

  return (
    <div className="relative h-full w-full bg-card">
      {state === "loading" && (
        <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
          Loading editor…
        </div>
      )}
      <div ref={hostRef} className="h-full w-full" aria-label="Lua script editor" />
    </div>
  );
}
