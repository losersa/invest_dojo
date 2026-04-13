import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@investdojo/core", "@investdojo/ui", "@investdojo/api"],

  // 启用 React 严格模式
  reactStrictMode: true,

  // 实验性功能
  experimental: {
    // Turbopack 默认开启
  },

  // 图片域名白名单
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.supabase.co" },
    ],
  },
};

export default nextConfig;
