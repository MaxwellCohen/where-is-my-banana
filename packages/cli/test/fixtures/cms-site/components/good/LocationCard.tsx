"use client";
import { useState } from "react";

export default function LocationCard({ name, phone, nearby }: { name: string; phone: string; nearby: number }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <h2>{name}</h2>
      <button onClick={() => setShow(!show)}>{show ? phone : "Call"}</button>
      <p>{nearby} nearby</p>
    </div>
  );
}
