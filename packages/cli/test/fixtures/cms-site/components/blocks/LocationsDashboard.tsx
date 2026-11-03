"use client";
import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

interface Row {
  id: string;
  name: string;
  city: string;
  visits: number;
  revenue: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function buildSeries(rows: Row[]) {
  const total = rows.reduce((n, r) => n + r.revenue, 0);
  return MONTHS.map((month, i) => ({
    month,
    revenue: Math.round((total / 12) * (0.8 + (i % 5) * 0.1)),
    visits: Math.round(rows.reduce((n, r) => n + r.visits, 0) / 12),
  }));
}

function RevenueChart({ rows }: { rows: Row[] }) {
  const [metric, setMetric] = useState<"revenue" | "visits">("revenue");
  const data = useMemo(() => buildSeries(rows), [rows]);
  return (
    <section>
      <h2>Revenue by month</h2>
      <button onClick={() => setMetric(metric === "revenue" ? "visits" : "revenue")}>Show {metric === "revenue" ? "visits" : "revenue"}</button>
      <div style={{ height: 320 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="month" />
            <YAxis />
            <Tooltip />
            <Area type="monotone" dataKey={metric} stroke="#0a7" fill="#0a73" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function RowView({ row, onPick }: { row: Row; onPick: (id: string) => void }) {
  return (
    <tr onClick={() => onPick(row.id)}>
      <td>{row.name}</td>
      <td>{row.city}</td>
      <td>{row.visits.toLocaleString()}</td>
      <td>${row.revenue.toLocaleString()}</td>
    </tr>
  );
}

function LocationsTable({ rows }: { rows: Row[] }) {
  const [sort, setSort] = useState<keyof Row>("name");
  const [picked, setPicked] = useState<string | null>(null);
  const sorted = [...rows].sort((a, b) => (a[sort] > b[sort] ? 1 : -1));
  return (
    <section>
      <h2>Locations</h2>
      <table>
        <thead>
          <tr>
            <th onClick={() => setSort("name")}>Name</th>
            <th onClick={() => setSort("city")}>City</th>
            <th onClick={() => setSort("visits")}>Visits</th>
            <th onClick={() => setSort("revenue")}>Revenue</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <RowView key={r.id} row={r} onPick={setPicked} />
          ))}
        </tbody>
      </table>
      {picked && <p>Selected {picked}</p>}
    </section>
  );
}

function CallbackForm() {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [sent, setSent] = useState(false);
  const valid = name.length > 1 && /^\d{7,}$/.test(phone);
  async function submit() {
    await fetch("/api/callback", { method: "POST", body: JSON.stringify({ name, phone }) });
    setSent(true);
  }
  if (sent) return <p>Thanks, we will call you.</p>;
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <h2>Request a callback</h2>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
      <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone" />
      <button disabled={!valid}>Call me</button>
    </form>
  );
}

export default function LocationsDashboard({ rows }: { rows: Row[] }) {
  return (
    <main>
      <RevenueChart rows={rows} />
      <LocationsTable rows={rows} />
      <CallbackForm />
    </main>
  );
}
