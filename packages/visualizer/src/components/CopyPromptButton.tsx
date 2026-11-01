"use client";

import { useEffect, useRef, useState } from "react";
import { buildAgentPrompt } from "@/lib/agent-prompt";

export function CopyPromptButton() {
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function onCopy() {
    const url = typeof window !== "undefined" ? window.location.origin : "https://wimb-visualizer.vercel.app";
    const text = buildAgentPrompt(url);
    let ok = true;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for older browsers / blocked clipboard
      const ta = document.createElement("textarea");
      try {
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        ok = typeof document.execCommand === "function" && document.execCommand("copy");
      } catch {
        ok = false;
      } finally {
        ta.remove();
      }
    }
    setCopied(ok ? "ok" : "fail");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(null), 2000);
  }

  return (
    <button type="button" className="copy-prompt-btn" onClick={() => void onCopy()}>
      {copied === "ok" ? "Copied!" : copied === "fail" ? "Copy failed" : "Copy prompt"}
    </button>
  );
}
