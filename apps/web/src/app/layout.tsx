import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "InvestDojo 投资道场",
  description: "模拟炒股 × 量化回测 × 财报分析 三合一投资学习平台",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
      </head>
      <body className="bg-rc-bg text-rc-text-primary antialiased">
        {children}
      </body>
    </html>
  );
}
