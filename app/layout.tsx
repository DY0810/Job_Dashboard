import type { Metadata } from 'next';
import { Archivo } from 'next/font/google';
import './globals.css';

/**
 * One family, three widths. The `wdth` axis is what lets the table run narrow (which buys
 * column width) while the tab labels run wide, without shipping a second font file.
 */
const archivo = Archivo({
  subsets: ['latin'],
  axes: ['wdth'],
  display: 'swap',
  variable: '--font-archivo',
});

export const metadata: Metadata = {
  title: 'Workie',
  description: 'Entry-to-mid design and engineering postings, newest first.',
};

/** Applies a stored theme choice before first paint, so a forced theme never flashes. */
const THEME_BOOT = `try{var t=localStorage.getItem('workie-theme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={archivo.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="bg-canvas text-fg">{children}</body>
    </html>
  );
}
