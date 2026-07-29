import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@investdojo/core", "@investdojo/ui", "@investdojo/api"],

  // 启用 React 严格模式
  reactStrictMode: true,

  // dev 模式跨域放行：通过 devcloud IP（非 localhost）访问 dev server 时，
  // Next 15.5 默认拦截 /_next/* 资源与 HMR 的跨域请求 → 页面/热更新挂掉。
  // 这里显式允许远端访问来源（仅 dev 生效，不影响生产构建）。
  allowedDevOrigins: ["9.134.148.2", "localhost", "127.0.0.1"],

  // 实验性功能
  experimental: {
    // Turbopack 默认开启
  },

  // 图片域名白名单
  images: {
    remotePatterns: [],
  },

  // 缓存策略：HTML 文档禁缓存（内部工具频繁重构建，避免中间代理/浏览器按
  // 预渲染默认的 s-maxage=31536000 把旧 HTML 缓存一年 → "改了没变化"）；
  // 带内容哈希的 _next/static 资源保持 immutable 长缓存。
  async headers() {
    return [
      {
        source: "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:js|css|png|jpg|jpeg|svg|webp|woff2?|map)).*)",
        headers: [
          { key: "Cache-Control", value: "no-cache, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
