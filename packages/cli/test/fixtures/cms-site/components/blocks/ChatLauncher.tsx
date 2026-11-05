"use client";
export default function ChatLauncher() {
  return <button onClick={() => (window as any).Intercom?.("show")}>Chat</button>;
}
