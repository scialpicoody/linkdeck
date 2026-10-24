import { useMemo, useState } from "react";
import type { InspectorFrame } from "./types";

type DetailView = "hex" | "ascii" | "json";

const HEX_CHARS = "0123456789abcdef";

function byteToHex(b: number): string {
  return HEX_CHARS.charAt((b >> 4) & 0xf) + HEX_CHARS.charAt(b & 0xf);
}

function isPrintable(b: number): boolean {
  return b >= 0x20 && b <= 0x7e;
}

function toAscii(payload: Uint8Array): string {
  let out = "";
  for (const b of payload) out += isPrintable(b) ? String.fromCharCode(b) : "·";
  return out;
}

function hexdump(payload: Uint8Array): string {
  const rows: string[] = [];
  for (let off = 0; off < payload.length; off += 16) {
    const slice = payload.slice(off, off + 16);
    const hex: string[] = [];
    let asc = "";
    for (let i = 0; i < 16; i++) {
      const b: number | undefined = slice[i];
      if (b === undefined) {
        hex.push("  ");
      } else {
        hex.push(byteToHex(b));
        asc += isPrintable(b) ? String.fromCharCode(b) : ".";
      }
      if (i === 7) hex.push("");
    }
    const offset = off.toString(16).padStart(8, "0");
    rows.push(`${offset}  ${hex.join(" ")}  |${asc}|`);
  }
  return rows.join("\n");
}

function utf8Text(payload: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(payload);
  } catch {
    return "";
  }
}

function jsonPreview(frame: InspectorFrame, text: string): string {
  const meta = {
    id: frame.id,
    channel: frame.channelName,
    direction: frame.direction,
    timestamp: new Date(frame.timestampMs).toISOString(),
    length: frame.payload.length,
  };
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return JSON.stringify({ meta, payload: parsed }, null, 2);
    } catch {
      // Not JSON — fall through to metadata + raw text.
    }
  }
  return JSON.stringify({ meta, text }, null, 2);
}

const VIEW_TABS: { id: DetailView; label: string }[] = [
  { id: "hex", label: "Hex" },
  { id: "ascii", label: "ASCII" },
  { id: "json", label: "JSON" },
];

export interface FrameDetailProps {
  /** Selected frame; null renders the empty state. */
  frame: InspectorFrame | null;
}

export default function FrameDetail({ frame }: FrameDetailProps) {
  const [view, setView] = useState<DetailView>("hex");

  const body = useMemo(() => {
    if (!frame) return "";
    switch (view) {
      case "hex":
        return hexdump(frame.payload);
      case "ascii":
        return toAscii(frame.payload);
      case "json":
        return jsonPreview(frame, utf8Text(frame.payload));
    }
  }, [frame, view]);

  if (!frame) {
    return (
      <div className="grid flex-1 place-items-center p-6 text-center">
        <p className="text-sm text-muted-foreground">
          No frame selected. Click a row in the frame monitor to inspect it here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-b border-border px-4 py-3 text-xs">
        <dt className="text-muted-foreground">Channel</dt>
        <dd className="truncate font-mono text-right text-card-foreground">{frame.channelName}</dd>
        <dt className="text-muted-foreground">Direction</dt>
        <dd className="font-mono text-right text-card-foreground">
          {frame.direction.toUpperCase()}
        </dd>
        <dt className="text-muted-foreground">Time</dt>
        <dd className="truncate font-mono text-right text-card-foreground">
          {new Date(frame.timestampMs).toLocaleTimeString()}
        </dd>
        <dt className="text-muted-foreground">Length</dt>
        <dd className="font-mono text-right text-card-foreground">{frame.payload.length} B</dd>
      </dl>

      <div
        role="tablist"
        aria-label="Frame views"
        className="flex gap-1 border-b border-border px-3 py-2"
      >
        {VIEW_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={view === t.id}
            type="button"
            onClick={() => setView(t.id)}
            className={
              view === t.id
                ? "rounded-md bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground"
                : "rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      <pre className="min-h-0 flex-1 overflow-auto bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-card-foreground">
        {body || "(empty payload)"}
      </pre>
    </div>
  );
}
