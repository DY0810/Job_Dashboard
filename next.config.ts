import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // A stray lockfile up the directory tree (outside this repo) makes Turbopack guess the
  // wrong workspace root. Pin it explicitly so builds are deterministic regardless.
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
