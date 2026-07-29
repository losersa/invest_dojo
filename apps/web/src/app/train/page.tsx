import { TrainPage } from "./TrainPage";
import { TrainHome } from "./TrainHome";

export const metadata = {
  title: "模型训练 · InvestDojo",
  description: "选择有信息量的因子，训练 LightGBM 涨跌方向模型",
};

// URL 约定：
//   /train                    → 目标股票模块首页（分模块选择）
//   /train?target=600519      → 训练页，预测目标锁定 600519，最近任务只看该目标
//   /train?target=__all__     → 训练页，全市场面板（不指定目标股）
//   /train?target=new         → 训练页，新建目标（可自由输入目标股票）
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ target?: string }>;
}) {
  const { target } = await searchParams;

  if (target === undefined) {
    return <TrainHome />;
  }

  // 解析目标：__all__ / new / 具体代码
  const isNew = target === "new";
  const isAll = target === "__all__";
  const initialTarget = isNew || isAll ? "" : target;
  // 具体代码模块：锁定目标，最近任务按该目标过滤；new/all 不锁定
  const targetLocked = !isNew && !isAll && /^\d{6}$/.test(target);

  return (
    <TrainPage
      initialTarget={initialTarget}
      targetLocked={targetLocked}
      recentScope={isAll ? "panel" : targetLocked ? "target" : "all"}
    />
  );
}
