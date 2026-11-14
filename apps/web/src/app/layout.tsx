import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

const inter = Inter({ subsets: ['latin', 'latin-ext'], variable: '--font-inter' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'Waymark',
  description: 'A living map of your projects.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="min-h-dvh font-sans antialiased">
        <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur-md">
          <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-3 px-5">
            <Link href="/" className="group flex items-center gap-2.5">
              <WaymarkGlyph />
              <span className="text-[15px] font-semibold tracking-tight text-text">waymark</span>
            </Link>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}

/** A waymark: a small cairn of three stones, the oldest trail marker. */
function WaymarkGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" className="text-accent">
      <ellipse cx="12" cy="19" rx="8" ry="3" fill="currentColor" opacity="0.35" />
      <ellipse cx="12" cy="13.5" rx="5.5" ry="2.6" fill="currentColor" opacity="0.65" />
      <ellipse cx="12" cy="8.5" rx="3.2" ry="2" fill="currentColor" />
      <circle cx="12" cy="4" r="1.2" fill="var(--live)" />
    </svg>
  );
}
