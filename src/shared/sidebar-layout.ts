// Codex desktop's stored width and tb() viewport clamp.
export const SIDEBAR_DEFAULT_WIDTH = 340;
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 520;
export const SIDEBAR_MIN_CONTENT_WIDTH = 240;

export function clampSidebarWidth(width: number, viewportWidth = Infinity): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(width, SIDEBAR_MAX_WIDTH, viewportWidth - SIDEBAR_MIN_CONTENT_WIDTH));
}
