"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  role: string; // "admin" | "staff" | "employee" | "user" | ""
}

/** 是否为内部员工（admin / staff / employee） */
export function isStaff(user: CurrentUser | null): boolean {
  if (!user) return false;
  return ["admin", "staff", "employee"].includes(user.role);
}

export function useCurrentUser() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        const meta = session.user.user_metadata ?? {};
        setUser({
          id: session.user.id,
          email: session.user.email ?? "",
          displayName: (meta.display_name as string) ?? "",
          role: (meta.role as string) ?? "",
        });
      }
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        const meta = session.user.user_metadata ?? {};
        setUser({
          id: session.user.id,
          email: session.user.email ?? "",
          displayName: (meta.display_name as string) ?? "",
          role: (meta.role as string) ?? "",
        });
      } else {
        setUser(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  return { user, loading };
}
