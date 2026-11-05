import { getPage, getNavigation, getFooter } from "@/lib/cms";
import PageRenderer from "@/components/blocks/PageRenderer";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const res = await fetch(`https://cdn.contentful.com/spaces/abc/entries?slug=${slug.join("/")}`, { cache: "no-store" });
  const raw = await res.json();
  const page = await getPage(slug.join("/"));
  const nav = await getNavigation();
  const footer = await getFooter();
  return <PageRenderer page={page} nav={nav} footer={footer} raw={raw} />;
}
