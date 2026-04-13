// @investdojo/api — 主入口
export { getSupabase, type SupabaseClient } from "./supabase";
export { RealtimeSync, type RealtimeCallbacks, type RealtimeEvent } from "./realtime";
export {
  fetchScenarioList,
  fetchScenarioData,
  saveProgress,
  streamAIReview,
} from "./scenario-api";
