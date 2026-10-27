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

/** Applies a collapsed sidebar and a dragged width (within SideResize's limits) before first paint, so neither flashes. */
const SIDE_BOOT = `try{var d=document.documentElement,w=+localStorage.getItem('workie-side-width');if(localStorage.getItem('workie-side')==='rail')d.dataset.side='rail';if(w>=200&&w<=400)d.style.setProperty('--side',w+'px')}catch(e){}`;

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
