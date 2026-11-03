export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'xenoflux-theme';

export function storedTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch { return 'system'; }
}

/** System follows the OS; Light or Dark overrides it (DESIGN.md › Tokens — Colors). */
export function setTheme(choice: ThemeChoice) {
  if (choice === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', choice);
  try { if (choice === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, choice); } catch { /* per-viewer convenience only */ }
}

export function applyStoredTheme() { setTheme(storedTheme()); }
