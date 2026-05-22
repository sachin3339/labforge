/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Control-plane address — server-side only. Browser never talks to the
  // control plane directly; everything goes through Next route handlers
  // so we can keep the API key in an httpOnly cookie.
  env: {
    LABFORGE_API_URL: process.env.LABFORGE_API_URL ?? 'http://localhost:4000',
  },
};

export default nextConfig;
