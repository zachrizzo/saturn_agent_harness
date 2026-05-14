export const OPEN_NAVIGATION_DRAWER_EVENT = "saturn:open-navigation-drawer";

export function requestNavigationDrawerOpen(): void {
  window.dispatchEvent(new Event(OPEN_NAVIGATION_DRAWER_EVENT));
}
