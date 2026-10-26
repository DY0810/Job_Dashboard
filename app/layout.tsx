import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

/** Postie's face, at the four weights its stylesheet uses. */
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: 'Workie',
  description: 'Entry-to-mid design and engineering postings, newest first.',
};

/** Applies a collapsed sidebar before first paint, so the rail never flashes open. */
const SIDE_BOOT = `try{if(localStorage.getItem('workie-side')==='rail')document.documentElement.dataset.side='rail'}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: SIDE_BOOT }} />
      </head>
      <body className="bg-canvas text-fg">
        <a className="skip-link" href="#main-content">Skip to main content</a>
        {children}
      </body>
    </html>
  );
}
