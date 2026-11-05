import { describe, it, expect } from "vitest";
import { run } from "./helpers.js";

describe("raw-img", () => {
  it("flags <img>", () => {
    const f = run("raw-img", { "app/a.tsx": `export const A = () => <img src="/a.png" />;` });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ check: "raw-img", file: "app/a.tsx", line: 1 });
  });
  it("skips files using next/image", () => {
    expect(run("raw-img", { "app/a.tsx": `import Image from "next/image";\nconst a = <img src="x"/>;` })).toHaveLength(0);
  });
});

describe("lcp-priority", () => {
  const src = (p: string) => `import Image from "next/image";\nexport const Hero = () => <Image src="/h.jpg" alt="" ${p} width={1} height={1} />;`;
  it("flags hero without priority", () => {
    const f = run("lcp-priority", { "components/Hero.tsx": src("") });
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("high");
  });
  it("accepts priority", () => {
    expect(run("lcp-priority", { "components/Hero.tsx": src("priority") })).toHaveLength(0);
  });
});

describe("image-config", () => {
  it("flags unoptimized, missing formats and remotePatterns", () => {
    const f = run("image-config", {
      "next.config.js": `module.exports = { images: { unoptimized: true } };`,
      "app/a.tsx": `import Image from "next/image";\nexport const A = () => <Image src="https://cdn.example.com/a.png" alt="" width={1} height={1} />;`,
    });
    expect(f.map((x) => x.id).sort()).toEqual(["image-config/formats", "image-config/remote-patterns", "image-config/unoptimized"]);
  });
  it("skips formats/remotePatterns when the app has no next/image or remote images", () => {
    expect(run("image-config", { "next.config.js": `module.exports = {};` })).toHaveLength(0);
  });
  it("passes a good config", () => {
    const c = `module.exports = { images: { formats: ["image/avif","image/webp"], remotePatterns: [{hostname:"a.com"}] } };`;
    expect(run("image-config", { "next.config.js": c })).toHaveLength(0);
  });
});

describe("cms-image-params", () => {
  it("flags bare Contentful URL", () => {
    const f = run("cms-image-params", { "lib/a.ts": `export const u = "https://images.ctfassets.net/abc/def/hero.jpg";` });
    expect(f).toHaveLength(1);
  });
  it("accepts URL with params", () => {
    expect(run("cms-image-params", { "lib/a.ts": `export const u = "https://images.ctfassets.net/abc/hero.jpg?w=800&fm=webp";` })).toHaveLength(0);
  });
});
