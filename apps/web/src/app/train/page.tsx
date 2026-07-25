import { TrainPage } from "./TrainPage";

export const metadata = {
  title: "模型训练 · InvestDojo",
  description: "选择有信息量的因子，训练 LightGBM 涨跌方向模型",
};

export default function Page() {
  return <TrainPage />;
}
