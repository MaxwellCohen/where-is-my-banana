"use client";
import { InlineWidget } from "react-calendly";

export default function Calendly({ url }: { url: string }) {
  return <InlineWidget url={url} />;
}
