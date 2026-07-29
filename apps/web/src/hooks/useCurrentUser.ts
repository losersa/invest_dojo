"use client";

import { useEffect, useState } from "react";
import {
  ensureUser,
  onAuthChange,
  type AuthUser,
} from "@/lib/auth/auth";

export type CurrentUser = AuthUser;

/** 是否为内部员工（admin / staff / employee） */
export function isStaff(user: CurrentUser | null): boolean {
  if (!user) return false;
  return ["admin", "staff", "employee"].includes(user.role);
}

export function useCurrentUser() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    ensureUser().then((u) => {
      setUser(u);
      setLoading(false);
    });
    const off = onAuthChange((u) => setUser(u));
    return off;
  }, []);

  return { user, loading };
}
