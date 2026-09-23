import type { Metadata } from 'next';
import { SignInForm } from './sign-in-form';
import { NotificationBell } from '../notification-bell';
import { AppNav } from '../app-nav';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Household access | Workie',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function SignInPage() {
  return (
    <main id="main-content" className="mx-auto min-h-dvh w-full max-w-[1720px] px-4 pb-16 md:px-6">
      <header className="app-header">
        <AppNav current="/sign-in" />
        <NotificationBell />
      </header>
      <section className="mx-auto w-full max-w-md py-10">
        <SignInForm />
      </section>
    </main>
  );
}
