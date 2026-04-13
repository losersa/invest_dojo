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
      <body className="bg-gray-950 text-gray-100 antialiased">
        {children}
      </body>
    </html>
  );
}
