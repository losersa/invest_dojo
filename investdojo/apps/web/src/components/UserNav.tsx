"use client";

// ============================================================
// UserNav — Raycast Design System
// Multi-layer shadow dropdown, opacity hover transitions
// ============================================================

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";

export function UserNav() {
  const router = useRouter();
  const supabase = createClient();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const getUser = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setUser(user);
      setLoading(false);
    };
    getUser();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setMenuOpen(false);
    router.push("/");
    router.refresh();
  };

  if (loading) {
    return <div className="w-8 h-8 rounded-[6px] bg-rc-surface-card animate-pulse" />;
  }

  if (!user) {
    return (
      <Link href="/login" className="rc-btn-glass text-[14px] px-4 py-2">
        登录
      </Link>
    );
  }

  const displayName =
    user.user_metadata?.display_name ??
    user.user_metadata?.full_name ??
    user.email?.split("@")[0] ??
    "U";

  const initial = displayName.charAt(0).toUpperCase();

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setMenuOpen(!menuOpen)}
        className="w-8 h-8 rounded-[6px] bg-rc-blue flex items-center justify-center text-[12px] font-semibold text-rc-btn-fg transition-opacity duration-150 hover:opacity-60"
      >
        {initial}
      </button>

      {menuOpen && (
        <div className="absolute right-0 top-11 w-56 rc-floating z-50">
          {/* User Info */}
          <div className="px-4 py-3 border-b border-rc-border-subtle">
            <p className="text-[14px] font-medium text-rc-text-primary truncate tracking-[0.2px]">
              {displayName}
            </p>
            <p className="text-[12px] text-rc-text-muted truncate mt-0.5 font-rc-mono">
              {user.email}
            </p>
          </div>

          {/* Menu Items */}
          <div className="py-1">
            <Link
              href="/profile"
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-3 px-4 py-2.5 text-[14px] text-rc-text-secondary hover:bg-white/[0.06] transition-colors duration-150 tracking-[0.2px]"
            >
              <span className="text-[14px]">👤</span>
              个人中心
            </Link>
            <Link
              href="/simulation"
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-3 px-4 py-2.5 text-[14px] text-rc-text-secondary hover:bg-white/[0.06] transition-colors duration-150 tracking-[0.2px]"
            >
              <span className="text-[14px]">🎮</span>
              历史模拟
            </Link>
          </div>

          {/* Logout */}
          <div className="border-t border-rc-border-subtle py-1">
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-[14px] text-rc-red hover:bg-white/[0.06] transition-colors duration-150 text-left tracking-[0.2px]"
            >
              <span className="text-[14px]">🚪</span>
              退出登录
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
