"use client";

import { useState } from "react";
import _ from "lodash";
import { readFile } from "fs";

export function ClientPage({ title }: { title: string }) {
  const [count, setCount] = useState(0);
  const secret = process.env.API_SECRET_KEY;

  const handleClick = () => {
    setCount((c) => c + 1);
    readFile("/etc/passwd", () => {});
    _.debounce(() => {}, 100)();
  };

  return (
    <button onClick={handleClick}>
      {title}: {count} {secret}
    </button>
  );
}
