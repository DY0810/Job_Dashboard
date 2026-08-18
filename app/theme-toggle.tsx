'use client';

import { useEffect, useState } from 'react';

const KEY = 'workie-theme';

/**
 * The manual override. Both themes are tuned equally and the tool is used at all hours, so
 * neither is "the real one" — the default follows the system and this only overrules it.
 *
 * A native <select> because the platform already handles the keyboard, the label and the
 * popup. First render is always `system` on both sides, and the effect corrects it, so the
 * stored choice cannot cause a hydration mismatch (the boot script in layout.tsx has
 * already applied it to the document by then).
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState('system');

  useEffect(() => {
    const stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark') setTheme(stored);
  }, []);

  function apply(next: string) {
    setTheme(next);
    if (next === 'system') {
      delete document.documentElement.dataset.theme;
      localStorage.removeItem(KEY);
    } else {
      document.documentElement.dataset.theme = next;
      localStorage.setItem(KEY, next);
    }
  }

  return (
    <select
      aria-label="Theme"
      className="cursor-pointer bg-transparent text-fg-dim hover:text-fg"
      value={theme}
      onChange={(event) => apply(event.target.value)}
    >
      <option value="system">system</option>
      <option value="light">light</option>
      <option value="dark">dark</option>
    </select>
  );
}
