const isDev = process.env.NODE_ENV !== "production";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep dev HMR chunks separate from production builds. Running `next build`
  // while `next dev` is active can otherwise corrupt the shared .next cache.
  distDir: process.env.NEXT_DIST_DIR ?? (isDev ? ".next-dev" : ".next-build"),
  experimental: {
    // The webpack build worker can race manifest reads on first clean builds when
    // using a custom distDir. Keep the build in-process so generated manifests are
    // always present before Next's page-data collection step starts.
    webpackBuildWorker: false,
  },
  webpack(config, { dev }) {
    if (dev && Array.isArray(config.plugins)) {
      config.plugins = config.plugins.filter((plugin) => (
        plugin?.constructor?.name !== "MemoryWithGcCachePlugin"
      ));
    }
    return config;
  },
};

export default nextConfig;
