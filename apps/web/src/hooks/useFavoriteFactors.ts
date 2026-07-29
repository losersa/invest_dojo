"use client";

/**
 * 因子收藏 Hook
 * - 通过 localStorage 实现跨页面同步
 * - 登录后额外写入数据库
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ensureUser } from "@/lib/auth/auth";

const LOCAL_KEY = "investdojo_factor_favorites";

// 简单的外部存储，让多个组件共享同一份数据
let memoryFavorites: string[] = [];
// SSR 快照必须是稳定引用，否则 useSyncExternalStore 会报
// "The result of getServerSnapshot should be cached" 并可能无限循环
const SERVER_SNAPSHOT: string[] = [];
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
  const favorites = useSyncExternalStore(subscribe, getFavorites, () => SERVER_SNAPSHOT);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    ensureUser().then((u) => {
      if (u) setUserId(u.id);
      // 注：原 DB 收藏同步（user_factor_favorites 经 PostgREST）已随 Supabase 移除；
      // 现仅用 localStorage 维护收藏，后续可接自建收藏接口。
    });
  }, []);

  const addFavorite = useCallback(async (factorId: string) => {
    if (memoryFavorites.includes(factorId)) return;
    setFavorites([...memoryFavorites, factorId]);
  }, []);

  const removeFavorite = useCallback(async (factorId: string) => {
    setFavorites(memoryFavorites.filter((id) => id !== factorId));
  }, []);

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
