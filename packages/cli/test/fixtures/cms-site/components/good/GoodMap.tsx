"use client";
export default function GoodMap({ points }: { points: { lat: number; lng: number }[] }) {
  return <div>{points.length} points</div>;
}
