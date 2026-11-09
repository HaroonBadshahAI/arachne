/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["playwright", "playwright-core", "cheerio", "turndown"],
  poweredByHeader: false,
};

export default nextConfig;
