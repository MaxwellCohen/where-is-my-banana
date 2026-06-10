import dynamic from "next/dynamic";

const DynamicChart = dynamic(() => import("recharts").then((m) => m.LineChart), {
  ssr: false,
});

export function LazyChart() {
  return <DynamicChart width={400} height={300} data={[]} />;
}
