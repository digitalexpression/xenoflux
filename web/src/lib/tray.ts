import { useSyncExternalStore } from 'react';
import type { SessionRow, Side } from '@/api/types';

/**
 * The two sessions picked for a comparison. Picking happens wherever sessions
 * are listed, so the pair lives outside any page and survives navigation and
 * reload within this window. Left is side A.
 */
export interface Tray { left: SessionRow | null; right: SessionRow | null }

const KEY = 'xenoflux.comparison-tray';
const EMPTY: Tray = { left: null, right: null };

function read(): Tray {
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(KEY) ?? 'null') as Partial<Tray> | null;
    return { left: stored?.left?.key ? stored.left : null, right: stored?.right?.key ? stored.right : null };
  } catch { return EMPTY; }
}

let tray: Tray = typeof window === 'undefined' ? EMPTY : read();
const listeners = new Set<() => void>();

function write(next: Tray) {
  tray = next;
  try {
    if (next.left || next.right) window.sessionStorage.setItem(KEY, JSON.stringify(next));
    else window.sessionStorage.removeItem(KEY);
  } catch { /* the pair still holds for this page */ }
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useTray(): Tray {
  return useSyncExternalStore(subscribe, () => tray, () => EMPTY);
}

export const traySide = (current: Tray, key: string): Side | null =>
  current.left?.key === key ? 'a' : current.right?.key === key ? 'b' : null;
export const trayFull = (current: Tray) => Boolean(current.left && current.right);

/** Remove a picked session, or put a new one on the first free side. A full tray ignores new sessions. */
export function toggleTray(row: SessionRow) {
  if (tray.left?.key === row.key) write({ ...tray, left: null });
  else if (tray.right?.key === row.key) write({ ...tray, right: null });
  else if (!tray.left) write({ ...tray, left: row });
  else if (!tray.right) write({ ...tray, right: row });
}
export function swapTray() { write({ left: tray.right, right: tray.left }); }
export function clearTray() { write(EMPTY); }
