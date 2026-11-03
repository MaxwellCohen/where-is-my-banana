"use client";
import { registry, ChatLauncher } from "./registry";

export default function PageRenderer({ page, nav, footer, raw }: { page: any; nav: any; footer: any; raw: any }) {
  const bg = "https://images.ctfassets.net/abc123/bg/77aa/texture.png";
  return (
    <main style={{ backgroundImage: `url(${bg})` }}>
      {page.items[0].fields.blocks.map((b: any) => {
        const C = registry[b.type];
        return C ? <C key={b.id} {...b.fields} /> : null;
      })}
      <ChatLauncher />
    </main>
  );
}
