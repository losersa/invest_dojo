// ============================================================
// Zustand Store — 模拟炒股状态管理
// 包装 @investdojo/core 的纯逻辑层
// ============================================================

import { create } from "zustand";
import {
  type SimulationState,
  type SimulationActions,
  initialSimulationState,
  createSimulationActions,
} from "@investdojo/core";

type SimulationStore = SimulationState & SimulationActions;

export const useSimulationStore = create<SimulationStore>((set, get) => ({
  ...initialSimulationState,
  ...createSimulationActions(
    (partial) => set(partial),
    () => get(),
  ),
}));
