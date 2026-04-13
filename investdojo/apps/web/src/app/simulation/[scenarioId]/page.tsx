import { SimulationPlayground } from "./SimulationPlayground";

export default function ScenarioPage({
  params,
}: {
  params: Promise<{ scenarioId: string }>;
}) {
  // Next.js 15 App Router: params is a Promise
  return <SimulationPlayground paramsPromise={params} />;
}
