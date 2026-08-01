import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The wider workspace (the-collection-room/) and the Expo app
  // (tcr-real-sdk54/) each have their own package-lock.json above this
  // project, which made Turbopack guess the wrong workspace root. Pinning
  // it to this project's own directory keeps the build (and Vercel, which
  // is configured with Root Directory: public-web) scoped to exactly this
  // project, never reaching into the Expo app's files.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
