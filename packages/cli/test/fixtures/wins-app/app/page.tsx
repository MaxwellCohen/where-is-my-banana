"use client";
import Hero from "../components/Hero";
import { Camera } from "lucide-react";
import PanelA from "../components/PanelA";
import PanelB from "../components/PanelB";

export default function Home() {
  return (
    <main>
      <Hero />
      <Camera />
      <PanelA />
      <PanelB />
    </main>
  );
}
