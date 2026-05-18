/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const api = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:8000';
    return [
      { source: '/api/:path((?!auth/).+)', destination: `${api}/api/:path` },
    ];
  },
};
export default nextConfig;
