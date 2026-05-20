/**
 * Next.js config for the vendor portal.
 *
 * - `reactStrictMode` on. The portal's realtime client uses effects to
 *   manage socket lifecycle; strict mode double-mount catches missing
 *   cleanups before they ship.
 * - `transpilePackages: ['@dankdash/types']` so the workspace package's
 *   `.ts` sources are compiled by Next without a separate build step.
 * - `webpack.resolve.extensionAlias` maps `.js` → [`.ts`, `.tsx`, `.js`]
 *   so the project-wide convention of writing `.js` extensions in TS
 *   source imports (per NodeNext ESM rules) resolves correctly through
 *   Next's bundler. Without this every cross-file import in src/ fails
 *   with `Module not found: Can't resolve './x.js'`.
 * - No `experimental.serverActions` flag — server actions are stable in
 *   Next 15.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@dankdash/types'],
  experimental: {
    typedRoutes: false,
  },
  webpack(config) {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return config;
  },
};

export default nextConfig;
