"use client";

import { useState } from "react";
import { buildAgentPrompt } from "@/lib/agent-prompt";

export function CopyPromptButton() {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    const url = typeof window !== "undefined" ? window.location.origin : "https://wimb-visualizer.vercel.app";
    const text = buildAgentPrompt(url);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for older browsers / blocked clipboard
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button type="button" className="copy-prompt-btn" onClick={() => void onCopy()}>
      {copied ? "Copied!" : "Copy prompt"}
    </button>
  );
}
