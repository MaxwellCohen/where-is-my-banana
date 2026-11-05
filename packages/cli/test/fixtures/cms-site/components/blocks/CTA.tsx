export default function CTA({ label, href }: { label: string; href: string }) {
  return <a href={href}>{label}</a>;
}
