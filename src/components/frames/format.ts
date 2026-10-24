/**
 * Formatting helpers for the frame table (#17). Pure functions; no I/O.
 *
 * Byte/data conversions reuse the terminal slice's helpers until the old
 * TerminalPanel is removed — single source, no duplicated logic.
 */

export { formatBytes, formatTs, frameBytes, toHex } from "../terminal/format";

const encoder = new TextEncoder();

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
