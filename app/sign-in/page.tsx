import type { Metadata } from 'next';
import Link from 'next/link';
import { SignInForm } from './sign-in-form';
import { NotificationBell } from '../notification-bell';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Sign in | Workie',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function SignInPage() {
  return (
    <main id="main-content" className="min-h-dvh px-4 pb-16">
      <header className="flex flex-wrap items-baseline gap-6 border-b border-rule py-2">
        <Link href="/" className="w-wide text-[13px] font-medium">Workie</Link>
        <nav aria-label="Account" className="flex gap-4 text-[11px]">
          <Link href="/">Jobs</Link>
          <span aria-current="page">Account</span>
        </nav>
        <NotificationBell />
      </header>
      <section className="mx-auto w-full max-w-sm py-8">
        <SignInForm />
      </section>
    </main>
  );
}
