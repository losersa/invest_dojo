import { Suspense } from "react";
import { LoginPage } from "./LoginPage";

export const metadata = {
  title: "登录 — InvestDojo 投资道场",
};

// useSearchParams 需要禁用静态生成
export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Suspense fallback={<div />}>
      <LoginPage />
    </Suspense>
  );
}
