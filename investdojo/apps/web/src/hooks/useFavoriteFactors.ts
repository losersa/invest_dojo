"use client";

/**
 * 因子收藏 Hook
 * - 通过 localStorage 实现跨页面同步
 * - 登录后额外写入数据库
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createClient } from "@/lib/supabase/client";

const LOCAL_KEY = "investdojo_factor_favorites";

// 简单的外部存储，让多个组件共享同一份数据
let memoryFavorites: string[] = [];
const listeners = new Set<() => void>();

function getFavorites(): string[] {
  return memoryFavorites;
}

function setFavorites(ids: string[]) {
  memoryFavorites = ids;
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(ids)); } catch {}
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// 初始化：从 localStorage 读
if (typeof window !== "undefined") {
  try {
    const saved = localStorage.getItem(LOCAL_KEY);
    if (saved) memoryFavorites = JSON.parse(saved);
  } catch {}
}

export function useFavoriteFactors() {
  const favorites = useSyncExternalStore(subscribe, getFavorites, () => []);
  const supabase = createClient();
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        setUserId(user.id);
        // 从数据库加载并合并
        const { data } = await supabase
          .from("user_factor_favorites")
          .select("factor_id")
          .eq("user_id", user.id);
        if (data && data.length > 0) {
          const dbFavs = data.map((r) => r.factor_id);
          const merged = Array.from(new Set([...memoryFavorites, ...dbFavs]));
          setFavorites(merged);
        }
      }
    };
    init();
  }, []);

  const addFavorite = useCallback(async (factorId: string) => {
    if (memoryFavorites.includes(factorId)) return;
    setFavorites([...memoryFavorites, factorId]);
    if (userId) {
      try { await supabase.from("user_factor_favorites").insert({ user_id: userId, factor_id: factorId }); } catch { /* ignore */ }
    }
  }, [userId, supabase]);

  const removeFavorite = useCallback(async (factorId: string) => {
    setFavorites(memoryFavorites.filter((id) => id !== factorId));
    if (userId) {
      try { await supabase.from("user_factor_favorites").delete().eq("user_id", userId).eq("factor_id", factorId); } catch { /* ignore */ }
    }
  }, [userId, supabase]);

  const toggleFavorite = useCallback(async (factorId: string) => {
    if (memoryFavorites.includes(factorId)) {
      await removeFavorite(factorId);
    } else {
      await addFavorite(factorId);
    }
  }, [addFavorite, removeFavorite]);

  const isFavorite = useCallback((factorId: string) => {
    return favorites.includes(factorId);
  }, [favorites]);

  return { favorites, addFavorite, removeFavorite, toggleFavorite, isFavorite };
}
