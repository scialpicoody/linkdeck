import { isMyGo } from "mygo-runtime";

/**
 * Whether the Go host is reachable. True inside the mygo window (native
 * app); false in plain-browser mode (`bun run dev:web`), where generated
 * bindings in mygo.ts throw or reject.
 *
 * Callers must degrade gracefully when this is false: never let a missing
 * host crash the render tree (see the top-level ErrorBoundary as the last
 * line of defense).
 */
export function isHostAvailable(): boolean {
  try {
    return isMyGo();
  } catch {
    return false;
  }
}
