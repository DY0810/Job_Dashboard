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
};

export default nextConfig;
