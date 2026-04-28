const isDev = process.env.NODE_ENV !== "production";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep dev HMR chunks separate from production builds. Running `next build`
  // while `next dev` is active can otherwise corrupt the shared .next cache.
  distDir: process.env.NEXT_DIST_DIR ?? (isDev ? ".next-dev" : ".next-build"),
};

export default nextConfig;
