/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // LABFORGE_API_URL is read at runtime from process.env (server-side only).
  // Do NOT put it in `env:` here — that inlines the build-time value and
  // breaks the production container which needs to read the runtime env.
};

export default nextConfig;
