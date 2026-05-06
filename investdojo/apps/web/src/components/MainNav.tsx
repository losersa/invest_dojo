"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserNav } from "./UserNav";

const NAV_ITEMS = [
  { href: "/kline", label: "K线图" },
  { href: "/factors", label: "因子库" },
  { href: "/simulation", label: "历史模拟" },
  { href: "/sdk-demo", label: "SDK Demo" },
];

export function MainNav() {
  const pathname = usePathname();

  return (
    <nav className="border-b border-[#1a1a1a] bg-black px-6 py-3 flex items-center justify-between sticky top-0 z-40">
      <div className="flex items-center gap-6">
        <Link
          href="/"
          className="text-white font-semibold text-lg tracking-tight hover:opacity-80 transition"
        >
          InvestDojo
        </Link>
        {NAV_ITEMS.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`text-sm transition ${
                isActive
                  ? "text-white font-medium"
                  : "text-[#888] hover:text-white"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
      <UserNav />
    </nav>
  );
}
