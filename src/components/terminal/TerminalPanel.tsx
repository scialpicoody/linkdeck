import { useEffect, useRef, useState } from "react";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { SerialService } from "../../mygo";
import {
  FLOOD_HIGH_WATERMARK_BYTES,
  LIST_ROW_CAP,
  MAX_WRITE_BYTES,
  SCROLLBACK_LINES,
  formatBytes,
  formatTs,
  frameBytes,
  toHex,
} from "./format";
import { serialPortName, type Frame, type TerminalPanelProps } from "./types";

/**
 * Serial frame monitor: an xterm.js canvas view over `frames` plus a
 * per-line hex/ascii frame list and a line-oriented send composer.
 *
 * Flood policy (see format.ts): scrollback is capped at SCROLLBACK_LINES;
 * bytes queued-but-unwritten past FLOOD_HIGH_WATERMARK_BYTES drop the oldest
 * queued frames first, surfaced in the dropped counter. xterm's own ~50 MB
 * discard watermark is never the plan.
 */
export default function TerminalPanel({ channel, frames, onSend }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XtermTerminal | null>(null);
  // Index into `frames` already handed to the queue (not necessarily written).
  const queuedCountRef = useRef(0);
  const queueRef = useRef<string[]>([]);
  const queueBytesRef = useRef(0);
  const writingRef = useRef(false);

  const [droppedFrames, setDroppedFrames] = useState(0);
  const [droppedBytes, setDroppedBytes] = useState(0);
  const [hexLines, setHexLines] = useState<ReadonlySet<number>>(new Set());
  const [composer, setComposer] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const port = serialPortName(channel);
  const channelLabel = port ?? (channel == null ? "no channel" : "non-serial channel");

  // xterm lifetime. Dynamic import() is deliberate here, not a style slip: a
  // static import would pull the ~345 KB xterm bundle into the initial chunk
  // on every load, while most sessions never open this panel
  // (docs/research/frontend-stack.md: keep heavyweights out of startup).
  useEffect(() => {
    let disposed = false;
    let term: XtermTerminal | null = null;
    (async () => {
      const { Terminal } = await import("@xterm/xterm");
      if (disposed) return;
      term = new Terminal({
        scrollback: SCROLLBACK_LINES,
        convertEol: true,
        cursorBlink: false,
      });
      termRef.current = term;
      if (hostRef.current) term.open(hostRef.current);
      pump();
    })().catch(() => {
      // Terminal view is progressive enhancement; the frame list below
      // remains fully usable when xterm fails to load.
    });
    return () => {
      disposed = true;
      term?.dispose();
      termRef.current = null;
      writingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset stream state when the channel changes; stale frames belong to the
  // previous port and must not replay into the new view.
  const channelKey = port ?? "__none__";
  const prevChannelKeyRef = useRef(channelKey);
  if (prevChannelKeyRef.current !== channelKey) {
    prevChannelKeyRef.current = channelKey;
    queuedCountRef.current = 0;
    queueRef.current = [];
    queueBytesRef.current = 0;
  }

  // Enqueue new frames with drop-oldest backpressure, then pump the writer.
  useEffect(() => {
    const fresh = frames.slice(queuedCountRef.current);
    if (fresh.length === 0) return;
    queuedCountRef.current = frames.length;
    let droppedN = 0;
    let droppedB = 0;
    for (const frame of fresh) {
      const text = frame.data.endsWith("\n") ? frame.data : frame.data + "\n";
      const len = frameBytes(text);
      while (
        queueRef.current.length > 0 &&
        queueBytesRef.current + len > FLOOD_HIGH_WATERMARK_BYTES
      ) {
        const oldest = queueRef.current.shift() as string;
        queueBytesRef.current -= frameBytes(oldest);
        droppedN += 1;
        droppedB += frameBytes(oldest);
      }
      queueRef.current.push(text);
      queueBytesRef.current += len;
    }
    if (droppedN > 0) {
      setDroppedFrames((n) => n + droppedN);
      setDroppedBytes((b) => b + droppedB);
    }
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames]);

  function pump() {
    const term = termRef.current;
    if (term == null || writingRef.current || queueRef.current.length === 0) return;
    writingRef.current = true;
    // Coalesce queued chunks into one write (see MAX_WRITE_BYTES).
    let chunk = "";
    while (queueRef.current.length > 0 && chunk.length < MAX_WRITE_BYTES) {
      const next = queueRef.current[0] as string;
      if (chunk.length > 0 && chunk.length + next.length > MAX_WRITE_BYTES) break;
      queueRef.current.shift();
      queueBytesRef.current -= frameBytes(next);
      chunk += next;
    }
    term.write(chunk, () => {
      writingRef.current = false;
      pump();
    });
  }

  function toggleHex(index: number) {
    setHexLines((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  async function handleSend() {
    if (composer.length === 0 || sending) return;
    const text = composer;
    setSendError(null);
    if (onSend) {
      // Mock/parent-owned path; never touches the transport directly.
      onSend(text);
      setComposer("");
      return;
    }
    if (port == null) return; // No-op stub: nothing serial to send to.
    setSending(true);
    try {
      await SerialService.send(port, text);
      setComposer("");
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  const start = Math.max(0, frames.length - LIST_ROW_CAP);
  const rows: Array<{ frame: Frame; index: number }> = [];
  for (let i = start; i < frames.length; i++) rows.push({ frame: frames[i] as Frame, index: i });

  return (
    <section aria-label="Terminal" className="flex min-h-0 flex-col rounded-[var(--radius)] border border-border bg-card text-foreground">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium">{channelLabel}</h2>
          <p className="text-xs text-muted-foreground">
            scrollback {SCROLLBACK_LINES} · flood cap {formatBytes(FLOOD_HIGH_WATERMARK_BYTES)}
          </p>
        </div>
        {droppedFrames > 0 && (
          <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <span role="status">
              flood protection dropped {droppedFrames} frame{droppedFrames === 1 ? "" : "s"} (
              {formatBytes(droppedBytes)})
            </span>
            <button
              type="button"
              onClick={() => {
                setDroppedFrames(0);
                setDroppedBytes(0);
              }}
              className="rounded-[var(--radius)] border border-input px-2 py-1 hover:opacity-90"
            >
              Clear
            </button>
          </div>
        )}
      </header>

      <div ref={hostRef} className="min-h-48 flex-1 bg-black/90" data-testid="xterm-host" />

      <ol aria-label="Frames" className="max-h-56 min-h-0 overflow-y-auto border-t border-border font-mono text-xs">
        {rows.length === 0 && (
          <li className="px-3 py-2 text-muted-foreground">No frames yet.</li>
        )}
        {rows.map(({ frame, index }) => {
          const hex = hexLines.has(index);
          return (
            <li key={index} className="flex items-baseline gap-2 border-b border-border/50 px-3 py-1">
              <span className="shrink-0 text-muted-foreground">{formatTs(frame.ts)}</span>
              <span
                className={
                  frame.dir === "in"
                    ? "shrink-0 text-emerald-600 dark:text-emerald-400"
                    : "shrink-0 text-sky-600 dark:text-sky-400"
                }
              >
                {frame.dir === "in" ? "←" : "→"}
              </span>
              <span className="min-w-0 flex-1 break-all whitespace-pre-wrap">
                {hex ? toHex(frame.data) : frame.data}
              </span>
              <button
                type="button"
                onClick={() => toggleHex(index)}
                aria-pressed={hex}
                aria-label={`Frame ${index + 1} view: ${hex ? "hex" : "ascii"}`}
                className="shrink-0 rounded-[var(--radius)] border border-input px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground hover:opacity-90"
              >
                {hex ? "hex" : "ascii"}
              </button>
            </li>
          );
        })}
      </ol>

      <form
        className="flex gap-2 border-t border-border px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSend();
        }}
      >
        <input
          value={composer}
          onChange={(e) => setComposer(e.target.value)}
          placeholder={port == null ? "Select a serial channel to send" : `Send to ${port}`}
          disabled={port == null && !onSend}
          aria-label="Send data"
          autoComplete="off"
          className="min-h-9 flex-1 rounded-[var(--radius)] border border-input bg-card px-3 py-1.5 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-2 focus:outline-ring disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={composer.length === 0 || sending || (port == null && !onSend)}
          className="min-h-9 rounded-[var(--radius)] bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          Send
        </button>
      </form>
      {sendError && (
        <p role="alert" className="border-t border-border px-3 py-1.5 text-xs text-red-600 dark:text-red-400">
          Send failed: {sendError}
        </p>
      )}
    </section>
  );
}
