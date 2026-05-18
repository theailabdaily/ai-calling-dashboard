/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const api = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:8000';
    // /api/auth/* belongs to NextAuth and MUST NOT be proxied to FastAPI.
    // `fallback` doesn't reliably prevent it (Vercel still claims those paths).
    // Bulletproof fix: regex negative lookahead on the source pattern so the
    // proxy only matches /api/* paths that do NOT start with "auth/".
    return [
      { source: '/api/:path((?!auth/).+)', destination: `${api}/api/:path` },
    ];
  },
};
export default nextConfig;
