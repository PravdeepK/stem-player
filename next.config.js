/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export so the renderer can be loaded from disk in a packaged Electron app.
  output: "export",
  // No Next.js image optimization server in a static export.
  images: { unoptimized: true },
  // Use relative asset paths so file:// loading works in Electron.
  assetPrefix: "./",
};

module.exports = nextConfig;
