/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const api = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:8000';
    // CRITICAL: /api/auth/* is owned by NextAuth and must NOT be rewritten to the
    // backend. We do that by using `beforeFiles` (handled before route lookup)
    // with a negative lookahead so any path that ISN'T /api/auth/* gets sent on.
    //
    // Order matters in Next.js rewrites:
    //   beforeFiles → checked before route resolution (lets us "claim" /api/auth/* for NextAuth)
    //   afterFiles  → checked after, only if no matching route was found
    // We use afterFiles here because Next.js will look up its own /api/auth/[...nextauth]
    // route handler first; only if no route matches will the rewrite run. That naturally
    // gives NextAuth precedence over the proxy.
    return {
      afterFiles: [
        { source: '/api/:path*', destination: `${api}/api/:path*` },
      ],
    };
  },
};
export default nextConfig;
