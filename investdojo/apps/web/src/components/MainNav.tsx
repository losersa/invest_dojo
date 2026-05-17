"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserNav } from "./UserNav";
import { useCurrentUser, isStaff } from "@/hooks/useCurrentUser";

interface NavItem {
  href: string;
  label: string;
  staffOnly?: boolean; // 仅内部员工可见
}

const NAV_ITEMS: NavItem[] = [
  { href: "/kline", label: "K线图" },
  { href: "/factors", label: "因子库" },
  { href: "/simulation", label: "历史模拟" },
  { href: "/overview", label: "项目全景" },
  { href: "/sdk-demo", label: "API 测试", staffOnly: true },
  { href: "/admin/data", label: "数据管理", staffOnly: true },
  { href: "/admin/progress", label: "项目进度", staffOnly: true },
];

export function MainNav() {
  const pathname = usePathname();
  const { user } = useCurrentUser();
  const staff = isStaff(user);

  return (
    <nav className="border-b border-[#1a1a1a] bg-black px-6 py-3 flex items-center justify-between sticky top-0 z-40">
      <div className="flex items-center gap-6">
        <Link
          href="/"
          className="text-white font-semibold text-lg tracking-tight hover:opacity-80 transition"
        >
          InvestDojo
        </Link>
        {NAV_ITEMS.filter((item) => !item.staffOnly || staff).map((item) => {
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
              {item.staffOnly && (
                <span className="ml-1 text-[10px] text-yellow-500/60">内部</span>
              )}
            </Link>
          );
        })}
      </div>
      <UserNav />
    </nav>
  );
}
