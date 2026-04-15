import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ProfilePage } from "./ProfilePage";

export const metadata = {
  title: "个人中心 — InvestDojo 投资道场",
};

export default async function Page() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?redirect=/profile");
  }

  return <ProfilePage user={user} />;
}
