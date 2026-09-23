import Link from 'next/link';

const destinations = [
  ['Jobs', '/'],
  ['Applications', '/applications'],
  ['Profile', '/profile'],
  ['Workers', '/workers'],
  ['Notes', '/talkie'],
  ['Settings', '/settings'],
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
      <Link href="/sign-in" prefetch={false} className="app-account" aria-current={current === '/sign-in' ? 'page' : undefined}>Account</Link>
    </div>
  );
}
