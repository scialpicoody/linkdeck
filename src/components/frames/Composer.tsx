import { useRef, useState } from "react";
import type { NewlineSuffix, SendCodec } from "./types";

export interface ComposerProps {
  channelName: string | null;
  canSend: boolean;
  sending: boolean;
  error: string | null;
  onSend: (payload: { ascii: SendCodec; text: string; suffix: NewlineSuffix }) => void;
}

const HISTORY_CAP = 50;

function suffixLabel(s: NewlineSuffix): string {
  switch (s) {
    case "none":
      return "None";
    case "lf":
      return "LF \\n";
    case "crlf":
      return "CRLF \\r\\n";
  }
}

/**
 * Send composer (#19): ASCII/HEX codec + newline suffix + history.
 *
 * Encoding contract: ASCII text and the suffix go out verbatim; HEX input
 * is `AA BB …` bytes. The owner converts to the wire form (base64 for the
 * Go []byte param) — this component only validates and labels.
 */
export default function Composer({ channelName, canSend, sending, error, onSend }: ComposerProps) {
  const [text, setText] = useState("");
  const [codec, setCodec] = useState<SendCodec>("ascii");
  const [suffix, setSuffix] = useState<NewlineSuffix>("lf");
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [hexError, setHexError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  function validateHex(value: string): boolean {
    const compact = value.replace(/\s+/g, "");
    if (compact.length === 0) {
      setHexError(null);
      return true;
    }
    if (!/^[0-9a-fA-F]*$/.test(compact)) {
      setHexError("HEX: only 0-9 A-F and spaces.");
      return false;
    }
    if (compact.length % 2 !== 0) {
      setHexError("HEX: odd number of digits — need full bytes.");
      return false;
    }
    setHexError(null);
    return true;
  }

  function handleSend(): void {
    if (text.length === 0 || !canSend || sending) return;
    if (codec === "hex" && !validateHex(text)) return;
    onSend({ ascii: codec, text, suffix });
    setHistory((h) => [text, ...h].slice(0, HISTORY_CAP));
    setHistIdx(-1);
    setText("");
    setHexError(null);
    inputRef.current?.focus();
  }

  function recall(dir: 1 | -1): void {
    if (history.length === 0) return;
    const next = histIdx + dir;
    if (next < -1 || next >= history.length) return;
    setHistIdx(next);
    setText(next === -1 ? "" : (history[next] as string));
  }

  return (
    <div className="border-t border-border">
      <form
        className="flex items-center gap-2 px-3 pt-2"
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
      >
        <fieldset className="flex shrink-0 items-center gap-1">
          <legend className="sr-only">Send codec</legend>
          {(["ascii", "hex"] as const).map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={codec === c}
              onClick={() => {
                setCodec(c);
                if (c === "ascii") setHexError(null);
                else validateHex(text);
              }}
              className={
                codec === c
                  ? "rounded-md bg-secondary px-2 py-1 font-mono text-xs font-medium"
                  : "rounded-md px-2 py-1 font-mono text-xs text-muted-foreground hover:bg-muted"
              }
            >
              {c.toUpperCase()}
            </button>
          ))}
        </fieldset>
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setHistIdx(-1);
            if (codec === "hex") validateHex(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              recall(1);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              recall(-1);
            }
          }}
          placeholder={
            canSend
              ? codec === "ascii"
                ? `Send to ${channelName} — ↑↓ history`
                : "HEX bytes, e.g. 41 54 0D 0A"
              : "Select a channel to send"
          }
          disabled={!canSend}
          aria-label="Send data"
          autoComplete="off"
          spellCheck={false}
          className="min-h-9 min-w-0 flex-1 rounded-[var(--radius)] border border-input bg-card px-3 py-1.5 font-mono text-sm placeholder:text-muted-foreground focus:outline-2 focus:outline-ring disabled:opacity-50"
        />
        <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <span className="sr-only">Line ending</span>
          <select
            value={suffix}
            onChange={(e) => setSuffix(e.target.value as NewlineSuffix)}
            disabled={!canSend}
            aria-label="Line ending"
            className="min-h-9 rounded-[var(--radius)] border border-input bg-card px-2 font-mono text-xs focus:outline-2 focus:outline-ring disabled:opacity-50"
          >
            {(["none", "lf", "crlf"] as const).map((s) => (
              <option key={s} value={s}>
                {suffixLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={text.length === 0 || !canSend || sending || hexError !== null}
          className="min-h-9 shrink-0 rounded-[var(--radius)] bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </form>
      {(hexError !== null || error !== null) && (
        <p role="alert" className="px-3 py-1.5 text-xs text-red-600 dark:text-red-400">
          {hexError ?? error}
        </p>
      )}
    </div>
  );
}
