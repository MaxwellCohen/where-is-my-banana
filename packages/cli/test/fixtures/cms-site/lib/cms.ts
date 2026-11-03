import { createClient } from "contentful";

const client = createClient({ space: process.env.CF_SPACE!, accessToken: process.env.CF_TOKEN! });

export const HERO_FALLBACK = "https://images.ctfassets.net/abc123/hero/9f8e/office-front.jpg";

export async function getPage(slug: string) {
  return client.getEntries({ content_type: "page", "fields.slug": slug, include: 10 });
}
export async function getNavigation() {
  return client.getEntries({ content_type: "navigation" });
}
export async function getFooter() {
  return client.getEntries({ content_type: "footer" });
}
