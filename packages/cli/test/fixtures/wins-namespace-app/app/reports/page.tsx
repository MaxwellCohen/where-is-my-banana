"use client";
import { useState } from "react";
import HeavyReport from "../../components/HeavyReport";

export default function Reports() {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <button onClick={() => setOpen(!open)}>Toggle</button>
      {open && <HeavyReport />}
    </main>
  );
}
