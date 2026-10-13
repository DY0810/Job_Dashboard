'use client';

import { useEffect, useState } from 'react';

import { Moon, Sun } from 'lucide-react';

const KEY = 'workie-theme';

/**
 * One click flips light and dark. Both themes are tuned equally; until it is pressed the
 * system decides (the boot script in layout.tsx applies a stored choice before paint).
 *
 * First render is always the light icon on both sides and the effect corrects it, so the
 * stored choice cannot cause a hydration mismatch.
 */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(KEY);
    setDark(stored === 'dark' || stored === 'light' ? stored === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
  }, []);

  function flip() {
    const next = dark ? 'light' : 'dark';
    setDark(!dark);
    document.documentElement.dataset.theme = next;
    localStorage.setItem(KEY, next);
  }

  const label = dark ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <button type="button" className="chip app-icon-button" onClick={flip} aria-label={label} title={label}>
      {dark ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
    </button>
  );
}
