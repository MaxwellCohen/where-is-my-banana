import moment from "moment";

export default function Testimonials({ items }: { items: { who: string; when: string; text: string }[] }) {
  return (
    <ul>
      {items.map((t) => (
        <li key={t.who}>
          {t.text} - {t.who}, {moment(t.when).fromNow()}
        </li>
      ))}
    </ul>
  );
}
