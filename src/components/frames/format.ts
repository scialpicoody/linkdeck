/** Formatting helpers for the frame table. Pure functions; no I/O. */

/** Byte length of a frame payload, for flood accounting. */
export function frameBytes(payload: Uint8Array): number {
  return payload.length;
}

/** Render a payload as space-separated lowercase hex pairs (`3c 7b ...`). */
export function toHex(payload: Uint8Array): string {
  let out = "";
  for (let i = 0; i < payload.length; i++) {
    const byte = payload[i] as number;
    if (i > 0) out += " ";
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** `HH:MM:SS.mmm` for a frame timestamp (epoch millis). */
export function formatTs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Human `N KB` / `N MB` rendering for counters. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Number of payload bytes in a frame. */
export function frameByteLength(payload: Uint8Array): number {
  return payload.length;
}

/**
 * Short single-line ASCII preview: non-printable bytes become a dot so rows
 * stay one line tall. Truncated with an ellipsis past `max` bytes.
 */
export function asciiPreview(payload: Uint8Array, max = 96): string {
  let out = "";
  for (const byte of payload) {
    if (out.length >= max) return `${out}...`;
    out += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
  }
  return out;
}

/**
 * Render a payload as space-separated lowercase hex pairs, truncated to
 * `maxBytes` with an ellipsis. Single-line so rows stay compact.
 */
export function hexPreview(payload: Uint8Array, maxBytes = 32): string {
  const shown = payload.subarray(0, maxBytes);
  let out = "";
  for (let i = 0; i < shown.length; i++) {
    const byte = shown[i] as number;
    if (i > 0) out += " ";
    out += byte.toString(16).padStart(2, "0");
  }
  return payload.length > maxBytes ? `${out} ...` : out;
}

/**
 * Case-insensitive keyword match against printable ASCII and hex forms, so a
 * search for "ab" also hits payload bytes 0xAB.
 */
export function frameMatches(frame: { payload: Uint8Array }, keyword: string): boolean {
  const query = keyword.trim().toLowerCase();
  if (query.length === 0) return true;
  if (asciiPreview(frame.payload, frame.payload.length).toLowerCase().includes(query)) {
    return true;
  }
  const compact = query.replace(/\s+/g, "");
  if (compact.length === 0) return true;
  return toHex(frame.payload).replaceAll(" ", "").includes(compact);
}
