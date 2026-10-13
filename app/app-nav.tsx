import Link from 'next/link';

const destinations = [
  ['Jobs', '/'],
  ['Auto Apply', '/applications'],
  ['Profile', '/profile'],
  ['Notes', '/talkie'],
] as const;

export function AppNav({ current }: { current: string }) {
  return (
    <div className="app-nav">
      <Link href="/" className="app-brand" aria-label="Workie home" prefetch={false}>
        Workie
      </Link>
      <nav aria-label="Primary navigation" className="app-nav-links">
        {destinations.map(([label, href]) => (
          <Link
            key={href}
            href={href}
            prefetch={false}
            aria-current={current === href ? 'page' : undefined}
          >
            {label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
