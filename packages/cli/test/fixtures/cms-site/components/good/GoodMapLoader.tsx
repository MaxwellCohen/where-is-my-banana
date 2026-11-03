"use client";
import dynamic from "next/dynamic";

const GoodMap = dynamic(() => import("./GoodMap"), {
  ssr: false,
  loading: () => <div style={{ height: 400 }} />,
});

export default function GoodMapLoader({ points }: { points: { lat: number; lng: number }[] }) {
  return <GoodMap points={points} />;
}
