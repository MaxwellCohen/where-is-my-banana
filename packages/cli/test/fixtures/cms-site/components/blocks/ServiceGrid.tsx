import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTooth } from "@fortawesome/free-solid-svg-icons";

export default function ServiceGrid({ services }: { services: { name: string }[] }) {
  return (
    <ul>
      {services.map((s) => (
        <li key={s.name}>
          <FontAwesomeIcon icon={faTooth} /> {s.name}
        </li>
      ))}
    </ul>
  );
}
