import { SimulationPlayground } from "./SimulationPlayground";

export default async function ScenarioPage({
  params,
}: {
  params: Promise<{ scenarioId: string }>;
}) {
  // Next.js 15 App Router: params is a Promise, await it in the Server Component
  const { scenarioId } = await params;
  return <SimulationPlayground scenarioId={scenarioId} />;
}
