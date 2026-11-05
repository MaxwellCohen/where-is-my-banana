"use client";
import { useMemo, useState } from "react";

interface Loc {
  id: string;
  name: string;
  city: string;
  open: boolean;
  rating: number;
}

function matches(l: Loc, q: string, onlyOpen: boolean) {
  return (!onlyOpen || l.open) && (l.name + l.city).toLowerCase().includes(q.toLowerCase());
}

function FilterBar({ q, onlyOpen, setQ, setOnlyOpen }: { q: string; onlyOpen: boolean; setQ: (v: string) => void; setOnlyOpen: (v: boolean) => void }) {
  return (
    <div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search locations" />
      <label>
        <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Open now
      </label>
    </div>
  );
}

function Summary({ shown, total }: { shown: number; total: number }) {
  return (
    <p>
      Showing {shown} of {total} locations
    </p>
  );
}

function ResultList({ items, selected, onSelect }: { items: Loc[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <ul>
      {items.map((l) => (
        <li key={l.id} aria-current={selected === l.id} onClick={() => onSelect(l.id)}>
          <strong>{l.name}</strong> {l.city} {l.open ? "(open)" : "(closed)"} {l.rating.toFixed(1)}
        </li>
      ))}
    </ul>
  );
}

function Details({ loc }: { loc: Loc | undefined }) {
  if (!loc) return <p>Select a location</p>;
  return (
    <aside>
      <h3>{loc.name}</h3>
      <p>{loc.city}</p>
      <p>{loc.open ? "Open now" : "Closed"}</p>
      <p>Rated {loc.rating.toFixed(1)} / 5</p>
    </aside>
  );
}

export default function LocationsExplorer({ locations }: { locations: Loc[] }) {
  const [q, setQ] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const items = useMemo(() => locations.filter((l) => matches(l, q, onlyOpen)), [locations, q, onlyOpen]);
  return (
    <section>
      <FilterBar q={q} onlyOpen={onlyOpen} setQ={setQ} setOnlyOpen={setOnlyOpen} />
      <Summary shown={items.length} total={locations.length} />
      <ResultList items={items} selected={selected} onSelect={setSelected} />
      <Details loc={locations.find((l) => l.id === selected)} />
    </section>
  );
}
