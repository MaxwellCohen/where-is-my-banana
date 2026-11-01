import type { KeyboardEvent } from "react";

/** Props that make an SVG element keyboard-activatable. */
export function buttonProps(label: string, onActivate: () => void) {
  return {
    tabIndex: 0,
    role: "button" as const,
    "aria-label": label,
    onClick: onActivate,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onActivate();
      }
    },
  };
}
