/**
 * Formatting helpers for the frame table (#17). Pure functions; no I/O.
 *
 * Byte/data conversions live here (single source); the old terminal slice
 * is gone with TerminalPanel.
 */

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

/** Number of payload bytes in a frame (UTF-8). */
export function frameByteLength(data: string): number {
  return encoder.encode(data).length;
}

/**
 * Short single-line ASCII preview: control chars and newlines become `·`
 * so rows stay one line tall. Truncated with an ellipsis past `max` chars.
 */
export function asciiPreview(data: string, max = 96): string {
  const flat = data.replace(/[\r\n\t]/g, "·");
  const clean = [...flat].map((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? "·" : ch;
  });
  const joined = clean.join("");
  return joined.length > max ? `${joined.slice(0, max)}…` : joined;
}

/**
 * Render a payload as space-separated lowercase hex pairs, truncated to
 * `maxBytes` with an ellipsis. Single-line so rows stay compact.
 */
export function hexPreview(data: string, maxBytes = 32): string {
  const bytes = encoder.encode(data);
  const shown = bytes.slice(0, maxBytes);
  let out = "";
  for (let i = 0; i < shown.length; i++) {
    const b = shown[i] as number;
    if (i > 0) out += " ";
    out += b.toString(16).padStart(2, "0");
  }
  return bytes.length > maxBytes ? `${out} …` : out;
}

/**
 * Case-insensitive keyword match against the ASCII text and its hex form,
 * so a search for "ab" also hits payload bytes 0xAB.
 */
export function frameMatches(frame: { data: string }, keyword: string): boolean {
  const q = keyword.trim().toLowerCase();
  if (q.length === 0) return true;
  if (frame.data.toLowerCase().includes(q)) return true;
  const compact = q.replace(/\s+/g, "");
  if (compact.length === 0) return true;
  const hex = encoder
    .encode(frame.data)
    .reduce((acc, b) => acc + (b as number).toString(16).padStart(2, "0"), "");
  return hex.includes(compact);
}
