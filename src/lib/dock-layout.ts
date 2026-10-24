export const DOCK_DEFAULT_WIDTH = 320;
export const DOCK_MIN_WIDTH = 260;
export const DOCK_MAX_WIDTH = 520;
export const DOCK_STORAGE_KEY = "linkdeck.dock-width.v1";
const DOCK_BREAKPOINT_PX = 1280;
const DOCK_KEYBOARD_STEP = 16;

export interface DockBounds {
  min: number;
  max: number;
}

/** Keep the dock wide enough to operate while preserving the frame stream. */
export function dockBounds(viewportWidth: number): DockBounds {
  const min = DOCK_MIN_WIDTH;
  const max = Math.max(min, Math.min(DOCK_MAX_WIDTH, Math.floor(viewportWidth * 0.5)));
  return { min, max };
}

export function clampDockWidth(width: number, viewportWidth: number): number {
  const { min, max } = dockBounds(viewportWidth);
  const finite = Number.isFinite(width) ? width : DOCK_DEFAULT_WIDTH;
  return Math.min(max, Math.max(min, Math.round(finite)));
}

/** Invalid or corrupted localStorage values fall back to the default. */
export function parseStoredDockWidth(raw: string | null, viewportWidth: number): number {
  if (raw === null) return clampDockWidth(DOCK_DEFAULT_WIDTH, viewportWidth);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return clampDockWidth(DOCK_DEFAULT_WIDTH, viewportWidth);
  }
  return clampDockWidth(parsed, viewportWidth);
}

export function widthFromPointer(
  startWidth: number,
  startX: number,
  currentX: number,
  viewportWidth: number,
): number {
  return clampDockWidth(startWidth + (startX - currentX), viewportWidth);
}

export function widthFromKey(width: number, key: string, viewportWidth: number): number | null {
  const { min, max } = dockBounds(viewportWidth);
  switch (key) {
    case "ArrowLeft":
      return clampDockWidth(width + DOCK_KEYBOARD_STEP, viewportWidth);
    case "ArrowRight":
      return clampDockWidth(width - DOCK_KEYBOARD_STEP, viewportWidth);
    case "Home":
      return min;
    case "End":
      return max;
    case "0":
      return clampDockWidth(DOCK_DEFAULT_WIDTH, viewportWidth);
    default:
      return null;
  }
}

export function dockIsStacked(viewportWidth: number): boolean {
  return viewportWidth < DOCK_BREAKPOINT_PX;
}
