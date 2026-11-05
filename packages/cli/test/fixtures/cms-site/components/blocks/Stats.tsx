export default function Stats({ stats }: { stats: { label: string; value: string }[] }) {
  return <dl>{stats.map((s) => <div key={s.label}><dt>{s.label}</dt><dd>{s.value}</dd></div>)}</dl>;
}
