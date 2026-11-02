"use client";

import { useEffect, useRef, useState } from "react";

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    try {
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      return typeof document.execCommand === "function" && document.execCommand("copy");
    } catch {
      return false;
    } finally {
      ta.remove();
    }
  }
}

/** Small click-to-copy button for a file path. */
export function CopyPath({ path, className }: { path: string; className?: string }) {
  const [state, setState] = useState<"ok" | "fail" | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function onCopy(e: React.MouseEvent) {
    e.stopPropagation();
    setState((await writeClipboard(path)) ? "ok" : "fail");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState(null), 1500);
  }

  return (
    <button
      type="button"
      className={`copy-path${className ? ` ${className}` : ""}`}
      title={state === "ok" ? "Copied!" : state === "fail" ? "Copy failed" : `Copy ${path}`}
      aria-label={`Copy path ${path}`}
      onClick={(e) => void onCopy(e)}
    >
      {state === "ok" ? "✓" : state === "fail" ? "✗" : "⧉"}
    </button>
  );
}
