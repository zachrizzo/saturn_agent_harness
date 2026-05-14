export const DEFAULT_INSPECTOR_WIDTH = 420;
export const INSPECTOR_WIDTH_LEGACY_KEY = "saturn.inspectorWidth";
export const INSPECTOR_WIDTH_MIN = 320;
export const INSPECTOR_WIDTH_MAX = 1100;

export function inspectorWidthStorageKey(sessionId: string): string {
  return `${INSPECTOR_WIDTH_LEGACY_KEY}:${sessionId}`;
}

export function validInspectorWidth(value: unknown): number | null {
  const width = Number(value);
  return Number.isFinite(width) && width >= INSPECTOR_WIDTH_MIN && width <= INSPECTOR_WIDTH_MAX
    ? width
    : null;
}

export function readStoredInspectorWidth(sessionId: string): number {
  if (typeof window === "undefined") return DEFAULT_INSPECTOR_WIDTH;
  return validInspectorWidth(window.localStorage.getItem(inspectorWidthStorageKey(sessionId)))
    ?? validInspectorWidth(window.localStorage.getItem(INSPECTOR_WIDTH_LEGACY_KEY))
    ?? DEFAULT_INSPECTOR_WIDTH;
}

export function writeStoredInspectorWidth(sessionId: string, width: number): void {
  const validWidth = validInspectorWidth(width);
  if (validWidth === null) return;
  window.localStorage.setItem(inspectorWidthStorageKey(sessionId), String(validWidth));
}
