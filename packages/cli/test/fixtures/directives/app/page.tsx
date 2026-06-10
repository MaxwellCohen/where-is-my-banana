// mention server-only in a comment should not trigger directive

/** server-only */

import { useState } from "react";

export default function Page() {
  const [n] = useState(0);
  return <div>{n}</div>;
}
