/**
 * Flood-control constants and hex/ascii formatting for the terminal panel.
 *
 * Numbers chosen per docs/research/frontend-stack.md §2 ("Memory behavior
 * under flood"): xterm's `write()` is non-blocking with a ~50 MB discard
 * parachute that must never be the strategy, so the panel gates consumption
 * well below it with caller-side drop-oldest accounting.
 */

/** Lines of scrollback retained by the xterm instance. Bounded, not infinite. */
export const SCROLLBACK_LINES = 2000;

/**
 * High watermark for bytes queued-but-unwritten to xterm. Past this the
 * panel drops the oldest queued frames and counts them. 256 KiB sits under
 * the research guide's ≤ ~500 KiB rule of thumb for snappy latency.
 */
export const FLOOD_HIGH_WATERMARK_BYTES = 256 * 1024;

/**
 * Bytes coalesced into a single `write()` call. Batching avoids the
 * per-chunk-callback inefficiency called out in the xterm flow-control guide.
 */
export const MAX_WRITE_BYTES = 64 * 1024;

/** Rows of the frame list rendered to the DOM; the live view is a tail. */
export const LIST_ROW_CAP = 200;

const encoder = new TextEncoder();

/** Byte length of a frame payload (UTF-8), for flood accounting. */
export function frameBytes(data: string): number {
  return encoder.encode(data).length;
}

/** Render a payload as space-separated lowercase hex pairs (`3c 7b …`). */
export function toHex(data: string): string {
  const bytes = encoder.encode(data);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    if (i > 0) out += " ";
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

/** `HH:MM:SS.mmm` for a frame timestamp (epoch millis). */
export function formatTs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Human `N KB` / `N MB` rendering for dropped-byte counters. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
