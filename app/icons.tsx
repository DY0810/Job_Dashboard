/** The whole icon set. Three glyphs do not justify a package, and nothing here is an emoji. */

const base = {
  width: 12,
  height: 12,
  viewBox: '0 0 12 12',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.25,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
};

export function ExternalLink() {
  return (
    <svg {...base}>
      <path d="M4.5 2H2v8h8V7.5" />
      <path d="M7 2h3v3M10 2 5.5 6.5" />
    </svg>
  );
}

export function Chevron() {
  return (
    <svg {...base}>
      <path d="m4.5 2.5 4 3.5-4 3.5" />
    </svg>
  );
}

export function Close() {
  return (
    <svg {...base}>
      <path d="m3 3 6 6M9 3l-6 6" />
    </svg>
  );
}
