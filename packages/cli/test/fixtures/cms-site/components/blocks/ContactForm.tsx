"use client";
import { useState } from "react";

export default function ContactForm() {
  const [sent, setSent] = useState(false);
  return <form onSubmit={() => setSent(true)}>{sent ? "Thanks" : <button>Send</button>}</form>;
}
