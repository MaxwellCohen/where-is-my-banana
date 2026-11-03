const BASE = "https://cdn.contentful.com/spaces/abc";

async function get(path: string) {
  const res = await fetch(`${BASE}/${path}`, { next: { revalidate: 3600, tags: ["cms"] } });
  return res.json();
}
export const getLocation = (slug: string) => get(`locations/${slug}`);
export const getNearby = (slug: string) => get(`locations/${slug}/nearby`);
export const getLocationSlugs = () => get("locations/slugs");
export const getService = (slug: string) => get(`services/${slug}`);
export const getServiceSlugs = () => get("services/slugs");
