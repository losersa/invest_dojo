import { ProfilePage } from "./ProfilePage";

export const metadata = {
  title: "个人中心 — InvestDojo 投资道场",
};

export default function Page() {
  // 个人中心为客户端组件，登录态由自建鉴权模块（/api/v1/auth/me）判断，
  // 未登录时 ProfilePage 内部会重定向到 /login。
  return <ProfilePage />;
}
