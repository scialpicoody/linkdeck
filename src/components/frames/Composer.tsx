import { CornerDownLeft, History, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isHostAvailable } from "../../lib/host";
import { cn } from "../../lib/utils";
import { type AutomationCommand, ConfigAPI } from "../../mygo";
import type { NewlineSuffix, SendCodec } from "./types";

export interface ComposerProps {
  channelName: string | null;
  canSend: boolean;
  sending: boolean;
  error: string | null;
  onSend: (payload: { ascii: SendCodec; text: string; suffix: NewlineSuffix }) => void;
}

interface QuickSend {
  id: string;
  label: string;
  text: string;
  codec: SendCodec;
  suffix: NewlineSuffix;
}

const HISTORY_CAP = 50;
const QUICK_STORAGE_KEY = "linkdeck.quick-sends.v1";
const HISTORY_STORAGE_KEY = "linkdeck.send-history.v1";

function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Persistence is best-effort in restricted webviews.
  }
}

function readQuickSends(): QuickSend[] {
  const raw = readLocal<Array<Partial<QuickSend>>>(QUICK_STORAGE_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (
      typeof item.id !== "string" ||
      typeof item.label !== "string" ||
      typeof item.text !== "string"
    ) {
      return [];
    }
    return [
      {
        id: item.id,
        label: item.label,
        text: item.text,
        codec: item.codec === "hex" ? "hex" : "ascii",
        suffix:
          item.suffix === "none" || item.suffix === "crlf" || item.suffix === "lf"
            ? item.suffix
            : "lf",
      },
    ];
  });
}

function commandsFromHost(commands: AutomationCommand[]): QuickSend[] {
  return commands.map((command) => ({
    id: `command:${command.name}`,
    label: command.name,
    text: command.payload,
    codec: command.codec === "hex" ? "hex" : "ascii",
    suffix:
      command.lineEnding === "none" || command.lineEnding === "crlf" ? command.lineEnding : "lf",
  }));
}

async function saveHostCommand(item: QuickSend): Promise<void> {
  if (!isHostAvailable()) return;
  await ConfigAPI.saveAutomationCommand({
    name: item.label,
    codec: item.codec,
    payload: item.text,
    lineEnding: item.suffix,
    description: "Transmit quick send",
  });
}

function suffixLabel(suffix: NewlineSuffix): string {
  switch (suffix) {
    case "none":
      return "NONE";
    case "lf":
      return "LF";
    case "crlf":
      return "CRLF";
  }
}

function previewText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 32 ? `${flat.slice(0, 32)}…` : flat;
}

/**
 * Transmit dock: a multiline composer, per-codec history, and saved shortcuts.
 * It stays mounted beside the frame stream so send is always one action away.
 */
export default function Composer({ channelName, canSend, sending, error, onSend }: ComposerProps) {
  const [text, setText] = useState("");
  const [codec, setCodec] = useState<SendCodec>("ascii");
  const [suffix, setSuffix] = useState<NewlineSuffix>("lf");
  const [history, setHistory] = useState<Record<SendCodec, string[]>>(() =>
    readLocal(HISTORY_STORAGE_KEY, { ascii: [], hex: [] }),
  );
  const [histIdx, setHistIdx] = useState(-1);
  const [showHistory, setShowHistory] = useState(false);
  const [hexError, setHexError] = useState<string | null>(null);
  const [quickSends, setQuickSends] = useState<QuickSend[]>(readQuickSends);
  const quickSendsRef = useRef(quickSends);
  quickSendsRef.current = quickSends;
  const [editingQuickId, setEditingQuickId] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const codecHistory = history[codec];
  const editingQuick = useMemo(
    () => quickSends.find((item) => item.id === editingQuickId) ?? null,
    [quickSends, editingQuickId],
  );

  useEffect(() => {
    if (!isHostAvailable()) return;
    let cancelled = false;
    void ConfigAPI.automationLibrary()
      .then((library) => {
        if (cancelled) return;
        const host = commandsFromHost(library.commands);
        const hostNames = new Set(host.map((item) => item.label));
        const localOnly = quickSendsRef.current.filter((item) => !hostNames.has(item.label));
        const merged = [...host, ...localOnly];
        if (merged.length > 0) {
          setQuickSends(merged);
          writeLocal(QUICK_STORAGE_KEY, merged);
        }
        for (const item of localOnly) {
          void saveHostCommand(item).catch(() => {});
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function validateHex(value: string): boolean {
    const compact = value.replace(/\s+/g, "");
    if (compact.length === 0) {
      setHexError(null);
      return true;
    }
    if (!/^[0-9a-fA-F]*$/.test(compact)) {
      setHexError("Only 0-9 A-F and spaces are valid.");
      return false;
    }
    if (compact.length % 2 !== 0) {
      setHexError("Hex input needs complete byte pairs.");
      return false;
    }
    setHexError(null);
    return true;
  }

  function remember(value: string, targetCodec: SendCodec): void {
    setHistory((previous) => {
      const next = {
        ...previous,
        [targetCodec]: [value, ...previous[targetCodec].filter((item) => item !== value)].slice(
          0,
          HISTORY_CAP,
        ),
      };
      writeLocal(HISTORY_STORAGE_KEY, next);
      return next;
    });
  }

  function submit(targetText = text, targetCodec = codec, targetSuffix = suffix): void {
    if (targetText.trim().length === 0 || !canSend || sending) return;
    if (targetCodec === "hex" && !validateHex(targetText)) return;
    onSend({ ascii: targetCodec, text: targetText, suffix: targetSuffix });
    remember(targetText, targetCodec);
    setHistIdx(-1);
    setShowHistory(false);
    setText(targetText);
    setHexError(null);
    inputRef.current?.focus();
  }

  function recall(direction: 1 | -1): void {
    if (codecHistory.length === 0) return;
    const next = Math.min(Math.max(histIdx + direction, -1), codecHistory.length - 1);
    setHistIdx(next);
    setText(next === -1 ? "" : (codecHistory[next] as string));
  }

  function saveQuick(): void {
    if (text.trim().length === 0) return;
    if (editingQuick !== null) {
      const next = quickSends.map((item) =>
        item.id === editingQuick.id ? { ...item, text, codec, suffix } : item,
      );
      setQuickSends(next);
      writeLocal(QUICK_STORAGE_KEY, next);
      const updated = next.find((item) => item.id === editingQuick.id);
      if (updated) void saveHostCommand(updated).catch(() => {});
      setEditingQuickId(null);
      return;
    }
    const nextId = crypto.randomUUID();
    const next = [
      ...quickSends,
      {
        id: nextId,
        label: `${codec.toUpperCase()} ${String(quickSends.length + 1).padStart(2, "0")}`,
        text,
        codec,
        suffix,
      },
    ];
    setQuickSends(next);
    setEditingQuickId(nextId);
    writeLocal(QUICK_STORAGE_KEY, next);
    const saved = next.find((item) => item.id === nextId);
    if (saved) void saveHostCommand(saved).catch(() => {});
  }

  function loadQuick(item: QuickSend): void {
    setText(item.text);
    setCodec(item.codec);
    setSuffix(item.suffix);
    if (item.codec === "hex") validateHex(item.text);
    else setHexError(null);
    setHistIdx(-1);
    inputRef.current?.focus();
  }

  function deleteQuick(id: string): void {
    const next = quickSends.filter((item) => item.id !== id);
    setQuickSends(next);
    if (editingQuickId === id) setEditingQuickId(null);
    writeLocal(QUICK_STORAGE_KEY, next);
    const removed = quickSends.find((item) => item.id === id);
    if (removed && isHostAvailable()) {
      void ConfigAPI.deleteAutomationCommand(removed.label).catch(() => {});
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-panel-raised">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="eyebrow text-muted-foreground">Transmit</span>
        <span className="max-w-44 truncate font-mono text-[9px] text-muted-foreground">
          {channelName ?? "no target"}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2.5">
        <div className="flex items-center border border-border bg-card p-0.5">
          {(["ascii", "hex"] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={codec === item}
              onClick={() => {
                setCodec(item);
                if (item === "hex") validateHex(text);
                else setHexError(null);
                setHistIdx(-1);
              }}
              className={cn(
                "flex-1 px-2 py-1 font-mono text-[9px] uppercase transition-colors",
                codec === item
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-border" />
          <button
            type="button"
            onClick={() => setShowHistory((value) => !value)}
            aria-pressed={showHistory}
            title="Send history"
            className={cn(
              "grid size-6 place-items-center text-muted-foreground hover:text-foreground",
              showHistory && "bg-secondary text-foreground",
            )}
          >
            <History size={12} aria-hidden="true" />
          </button>
        </div>

        {showHistory && (
          <div className="max-h-28 overflow-y-auto border border-border bg-card">
            {codecHistory.length === 0 ? (
              <p className="px-2 py-2 text-[10px] text-muted-foreground">No history yet.</p>
            ) : (
              codecHistory.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => {
                    setText(item);
                    setShowHistory(false);
                    inputRef.current?.focus();
                  }}
                  className="block w-full truncate border-b border-border/60 px-2 py-1.5 text-left font-mono text-[9px] text-muted-foreground last:border-0 hover:bg-muted hover:text-foreground"
                >
                  {previewText(item)}
                </button>
              ))
            )}
          </div>
        )}

        <textarea
          ref={inputRef}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setHistIdx(-1);
            if (codec === "hex") validateHex(event.target.value);
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              submit();
            } else if (event.key === "ArrowUp" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              recall(1);
            } else if (event.key === "ArrowDown" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              recall(-1);
            }
          }}
          placeholder={
            canSend
              ? codec === "ascii"
                ? "Type a command or payload…"
                : "AA 55 01 0D 0A"
              : "Open a serial channel to transmit"
          }
          disabled={!canSend}
          aria-label="Send data"
          autoComplete="off"
          spellCheck={false}
          className="min-h-28 flex-1 resize-none border border-input bg-card p-2.5 font-mono text-[11px] leading-relaxed text-foreground placeholder:text-muted-foreground/70 focus:border-ring focus:outline-none disabled:bg-muted/50 disabled:opacity-70"
        />

        {(hexError !== null || error !== null) && (
          <p role="alert" className="text-[10px] leading-snug text-danger">
            {hexError ?? error}
          </p>
        )}

        <div className="flex items-center gap-1.5">
          <label className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="eyebrow shrink-0 text-muted-foreground">End</span>
            <select
              value={suffix}
              onChange={(event) => setSuffix(event.target.value as NewlineSuffix)}
              disabled={!canSend || codec === "hex"}
              aria-label="Line ending"
              className="h-8 min-w-0 flex-1 border border-input bg-card px-1.5 font-mono text-[9px] text-foreground focus:border-ring focus:outline-none disabled:opacity-50"
            >
              {(["none", "lf", "crlf"] as const).map((item) => (
                <option key={item} value={item}>
                  {suffixLabel(item)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => submit()}
            disabled={text.trim().length === 0 || !canSend || sending || hexError !== null}
            className="flex h-8 min-w-24 items-center justify-center gap-1.5 bg-primary px-3 text-[10px] font-semibold text-primary-foreground hover:bg-primary/88 disabled:opacity-45"
          >
            <Send size={12} aria-hidden="true" />
            {sending ? "Sending" : "Send"}
          </button>
        </div>
        <div className="flex items-center justify-between font-mono text-[8px] text-muted-foreground/75">
          <span>⌘/Ctrl + Enter to send</span>
          <span>{text.length} chars</span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col border-t border-border">
        <div className="flex h-8 shrink-0 items-center justify-between border-b border-border px-3">
          <span className="eyebrow text-muted-foreground">Quick send</span>
          <button
            type="button"
            onClick={saveQuick}
            disabled={text.trim().length === 0}
            className="flex items-center gap-1 font-mono text-[8px] text-muted-foreground uppercase hover:text-foreground disabled:opacity-40"
          >
            <Plus size={10} aria-hidden="true" />
            {editingQuick === null ? "Save current" : "Update"}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {quickSends.length === 0 ? (
            <div className="grid min-h-24 place-items-center px-5 text-center">
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                Save the current payload as a shortcut. Content and codec persist locally.
              </p>
            </div>
          ) : (
            <ul>
              {quickSends.map((item) => (
                <li
                  key={item.id}
                  className={cn(
                    "group flex min-h-9 items-center border-b border-border/60",
                    editingQuickId === item.id && "bg-secondary/60",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => loadQuick(item)}
                    className="min-w-0 flex-1 px-2.5 py-1.5 text-left"
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="font-mono text-[8px] text-muted-foreground uppercase">
                        {item.codec}
                      </span>
                      <span className="truncate font-mono text-[9px] text-foreground">
                        {previewText(item.text)}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      loadQuick(item);
                      setEditingQuickId(item.id);
                    }}
                    title="Edit shortcut"
                    aria-label={`Edit shortcut ${item.label}`}
                    className="grid size-7 place-items-center text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
                  >
                    <Pencil size={11} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => submit(item.text, item.codec, item.suffix)}
                    disabled={!canSend || sending}
                    title="Send shortcut now"
                    aria-label={`Send shortcut ${item.label}`}
                    className="grid size-7 place-items-center text-muted-foreground hover:text-primary disabled:opacity-35"
                  >
                    {item.codec === "hex" ? (
                      <CornerDownLeft size={12} aria-hidden="true" />
                    ) : (
                      <Send size={11} aria-hidden="true" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteQuick(item.id)}
                    title="Delete shortcut"
                    aria-label={`Delete shortcut ${item.label}`}
                    className="mr-1 grid size-7 place-items-center text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-danger"
                  >
                    <Trash2 size={11} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
