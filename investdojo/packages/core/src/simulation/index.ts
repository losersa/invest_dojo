// @investdojo/core — simulation module exports
export * from "./types";
export { SimulationEngine, type MatchResult } from "./engine";
export { ScenarioManager } from "./scenario";
export {
  type SimulationState,
  type SimulationActions,
  initialSimulationState,
  createSimulationActions,
} from "./store";
