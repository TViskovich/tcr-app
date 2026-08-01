import type { Metadata } from 'next';
import './globals.css';

// System font stack only (declared in globals.css) — no next/font/google
// dependency. This is a small, mostly-static public site; a downloaded
// webfont isn't worth the extra build-time fetch for it.
export const metadata: Metadata = {
  title: {
    default: 'CacheCase Registry',
    template: '%s · CacheCase Registry',
  },
  description: 'Public registry lookup for cards registered with CacheCase.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
