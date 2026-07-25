import { FactorDetailPage } from "./FactorDetailPage";

export default async function Page({
  params,
}: {
  params: Promise<{ factorId: string }>;
}) {
  const { factorId } = await params;
  return <FactorDetailPage factorId={decodeURIComponent(factorId)} />;
}
