/**
 * Next.js config for the consumer checkout web surface (Apple §10.4).
 *
 * - `transpilePackages: ['@dankdash/types']` so the workspace package's `.ts`
 *   sources compile through Next without a separate build step.
 * - `webpack.resolve.extensionAlias` maps `.js` → [`.ts`, `.tsx`, `.js`] so
 *   the repo-wide NodeNext convention of writing `.js` extensions in TS
 *   imports resolves through Next's bundler.
 * - `poweredByHeader: false` and a strict-ish header set — this surface
 *   handles a payment flow, so it should not advertise its stack or allow
 *   itself to be framed.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@dankdash/types'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
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
