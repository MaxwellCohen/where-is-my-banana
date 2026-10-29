"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import Chart from "../../components/Chart";
import ExportButton from "../../components/ExportButton";

const Widget = dynamic(() => import("../../components/Widget"));

export default function Dashboard() {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <button onClick={() => setOpen(!open)}>Toggle</button>
      {open && <Chart />}
      <ExportButton />
      <Widget />
    </main>
  );
}
