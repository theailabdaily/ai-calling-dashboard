/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const api = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:8000';
    // Why `fallback` and not `afterFiles`:
    //
    // Next.js rewrite ordering is:
    //   1. beforeFiles    — match before static files / pages / routes
    //   2. static files   — /public/*
    //   3. pages          — app/page.tsx, app/login/page.tsx etc.
    //   4. afterFiles     — match before DYNAMIC routes
    //   5. dynamic routes — [slug], [...catchAll], including app/api/auth/[...nextauth]
    //   6. fallback       — match only if no route at all
    //
    // `/api/auth/[...nextauth]/route.ts` is a dynamic catch-all (step 5). If we
    // put the proxy rewrite in afterFiles (step 4), the rewrite fires FIRST and
    // /api/auth/csrf gets forwarded to the FastAPI backend → 404.
    //
    // Putting the proxy in `fallback` makes it run last. NextAuth's catch-all
    // matches /api/auth/* first and serves the handler. Everything else
    // (/api/product-lines, /api/overview/*, etc.) has no matching Next route,
    // falls through, and gets proxied to FastAPI.
    return {
      fallback: [
        { source: '/api/:path*', destination: `${api}/api/:path*` },
      ],
    };
  },
};
export default nextConfig;
