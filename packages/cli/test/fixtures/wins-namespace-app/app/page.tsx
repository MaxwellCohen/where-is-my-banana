"use client";
import * as Icons from "big-icons";

export default function Home({ name }: { name: string }) {
  const Icon = (Icons as Record<string, any>)[name];
  return <main>{Icon ? <Icon /> : null}</main>;
}
