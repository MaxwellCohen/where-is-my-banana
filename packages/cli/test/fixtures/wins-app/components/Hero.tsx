"use client";
import { useEffect, useState } from "react";

export default function Hero() {
  const [t, setT] = useState(0);
  useEffect(() => setT(Date.now()), []);
  return <h1>Welcome {t}</h1>;
}
