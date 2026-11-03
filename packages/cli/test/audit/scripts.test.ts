import { describe, it, expect } from "vitest";
import { run } from "./helpers.js";

describe("third-party-script", () => {
  const layout = (attrs: string) =>
    `import Script from "next/script";\nexport default function L(){ return <html><body><Script src="https://www.googletagmanager.com/gtm.js" ${attrs} /></body></html>; }`;
  it("flags beforeInteractive", () => {
    const f = run("third-party-script", { "app/layout.tsx": layout('strategy="beforeInteractive"') });
    expect(f[0]).toMatchObject({ severity: "high", id: "third-party-script/before-interactive" });
  });
  it("flags missing strategy", () => {
    expect(run("third-party-script", { "app/layout.tsx": layout("") })[0].id).toBe("third-party-script/no-strategy");
  });
  it("flags raw script in layout", () => {
    const f = run("third-party-script", { "app/layout.tsx": `export default () => <head><script src="https://cdn.segment.com/a.js"></script></head>;` });
    expect(f[0].id).toBe("third-party-script/raw-script");
  });
  it("accepts lazyOnload", () => {
    expect(run("third-party-script", { "app/layout.tsx": layout('strategy="lazyOnload"') })).toHaveLength(0);
  });
  it("warns not to remove consent scripts", () => {
    const f = run("third-party-script", {
      "app/layout.tsx": `import Script from "next/script";\nexport default () => <Script src="https://cdn.cookielaw.org/x.js" strategy="beforeInteractive" />;`,
    });
    expect(f[0].fix).toMatch(/do NOT remove/i);
  });
});

describe("preview-code-in-prod", () => {
  it("flags unguarded preview SDK in layout", () => {
    const f = run("preview-code-in-prod", { "app/layout.tsx": `import { VisualEditing } from "next-sanity/visual-editing";\nexport default () => <VisualEditing/>;` });
    expect(f).toHaveLength(1);
  });
  it("passes when draftMode guarded", () => {
    const c = `import { draftMode } from "next/headers";\nimport { VisualEditing } from "next-sanity/visual-editing";\nexport default async () => (await draftMode()).isEnabled && <VisualEditing/>;`;
    expect(run("preview-code-in-prod", { "app/layout.tsx": c })).toHaveLength(0);
  });
});

describe("maps-widgets", () => {
  it("flags map import in a shared component", () => {
    const f = run("maps-widgets", { "components/shared/Footer.tsx": `import { GoogleMap } from "@react-google-maps/api";` });
    expect(f).toHaveLength(1);
  });
  it("allows dedicated locator file", () => {
    expect(run("maps-widgets", { "app/locations/LocatorMap.tsx": `import { GoogleMap } from "@react-google-maps/api";` })).toHaveLength(0);
  });
  it("flags widget imported by >3 non-dedicated files", () => {
    const files: Record<string, string> = {};
    for (const n of "abcd") files[`app/${n}/Thing.tsx`] = `import ReactPlayer from "react-player";`;
    expect(run("maps-widgets", files)).toHaveLength(4);
  });
});
