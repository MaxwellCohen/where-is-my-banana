import { describe, expect, it } from "vitest";
import { synGraph } from "../helpers-graph.js";
import { formatWhy, whyReport } from "../../src/why/index.js";

const MOMENT = "node_modules/moment/moment.js";
const mods = {
  layout: { path: "app/layout.tsx", sync: ["nav", "page"] },
  page: { path: "app/page.tsx", sync: ["dates", "chart"] },
  nav: { path: "components/Nav.tsx", sync: ["util"] },
  util: { path: "lib/util.ts", sync: ["moment"] },
  dates: { path: "components/Dates.tsx", sync: ["moment"] },
  chart: { path: "components/Chart.tsx", sync: ["dfns"] },
  dfns: { path: "node_modules/date-fns/index.js" },
  moment: { path: MOMENT },
};
const bytes = {
  "app/layout.tsx": 1000,
  "app/page.tsx": 1000,
  "components/Nav.tsx": 500,
  "lib/util.ts": 200,
  "components/Dates.tsx": 300,
  "components/Chart.tsx": 400,
  "node_modules/date-fns/index.js": 5000,
  [MOMENT]: 60000,
};
const g = synGraph(mods, { "/": { seeds: ["layout"], bytes } }, { "/": { "node_modules/pg/index.js": 9000 } });

describe("why", () => {
  it("lists multiple chains with distinct first hops and cut analysis", () => {
    const r = whyReport(g, "moment");
    expect(r.routes).toHaveLength(1);
    const route = r.routes[0];
    expect(route.chains.length).toBe(2);
    expect(route.chains[0].chain).toEqual(["app/layout.tsx", "components/Nav.tsx", "lib/util.ts", MOMENT]);
    expect(route.chains[1].chain).toEqual(["app/layout.tsx", "app/page.tsx", "components/Dates.tsx", MOMENT]);
    expect(route.uniqueBytes).toBe(60000);
    expect(route.subtreeBytes).toBe(60000);
    // cutting only one chain's edge saves nothing: the other still keeps it alive
    const cut = route.chains[0].cut!;
    expect(cut.importer).toBe("lib/util.ts");
    expect(cut.savedBytes).toBe(0);
    expect(cut.stillReachableVia).toEqual(route.chains[1].chain);
    const text = formatWhy(r);
    expect(text).toContain("saves 0.0 KB: still reachable via");
  });

  it("respects --chains and --route", () => {
    expect(whyReport(g, "moment", { chains: 1 }).routes[0].chains).toHaveLength(1);
    expect(whyReport(g, "moment", { route: "/nope" }).routes).toHaveLength(0);
  });

  it("flags server-only packages", () => {
    const r = whyReport(g, "pg");
    expect(r.routes).toHaveLength(0);
    expect(r.notFound).toBe("server-only");
    expect(r.message).toContain("server");
  });

  it("not found", () => {
    const r = whyReport(g, "lodash");
    expect(r.routes).toHaveLength(0);
    expect(r.notFound).toBe("absent");
  });

  it("ambiguous substring lists matches; glob matches several", () => {
    const amb = whyReport(g, "ate");
    expect(amb.routes).toHaveLength(0);
    expect(amb.matches).toContain("components/Dates.tsx");
    expect(whyReport(g, "mo*").matches).toEqual(["moment"]);
    const glob = whyReport(g, "components/*");
    expect(glob.matches).toHaveLength(3);
    expect(glob.routes[0].subtreeBytes).toBe(66400);
  });

  it("matches a file path", () => {
    const r = whyReport(g, "components/Chart.tsx");
    expect(r.routes[0].chains[0].chain).toEqual(["app/layout.tsx", "app/page.tsx", "components/Chart.tsx"]);
    expect(r.routes[0].chains[0].cut!.savedBytes).toBe(5400);
  });
});
