import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native addon: it must be required at runtime, not bundled.
  serverExternalPackages: ['better-sqlite3'],
  // A stray lockfile up the directory tree (outside this repo) makes Turbopack guess the
  // wrong workspace root. Pin it explicitly so builds are deterministic regardless.
  turbopack: {
    root: path.resolve(__dirname),
  },
  // Every view is force-dynamic (filters live in the URL), so without this the CDN never
  // caches and every load — including the ~1s cold start — hits the function. The corpus
  // refreshes every 30 minutes; serving a view up to 5 minutes old, and a stale one while
  // the next renders, costs nothing visible. Vercel-CDN-Cache-Control is the edge-only
  // header: Next keeps setting its own browser Cache-Control (no-store), so back/forward
  // and reloads in the browser stay fresh — only the CDN holds a copy.
  async headers() {
    const edge = { key: 'Vercel-CDN-Cache-Control', value: 'max-age=300, stale-while-revalidate=1500' };
    return [
      { source: '/', headers: [edge] },
      { source: '/api/postings/:id', headers: [edge] },
    ];
  },
};

export default nextConfig;
