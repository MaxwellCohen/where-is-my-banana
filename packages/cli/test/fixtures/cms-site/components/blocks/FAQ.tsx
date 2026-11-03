"use client";
import { useState } from "react";
import _ from "lodash";

export default function FAQ({ items }: { items: { q: string; a: string }[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <dl>
      {_.map(items, (it) => (
        <div key={it.q} onClick={() => setOpen(it.q)}>
          <dt>{it.q}</dt>
          {open === it.q && <dd>{it.a}</dd>}
        </div>
      ))}
    </dl>
  );
}
