import { getLocation, getLocationSlugs, getNearby } from "@/lib/good-cms";
import LocationCard from "@/components/good/LocationCard";
import GoodHero from "@/components/good/GoodHero";

export const revalidate = 3600;

export async function generateStaticParams() {
  return (await getLocationSlugs()).map((slug: string) => ({ slug }));
}

export default async function LocationPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [location, nearby] = await Promise.all([getLocation(slug), getNearby(slug)]);
  return (
    <>
      <GoodHero title={location.title} src={location.hero} />
      <LocationCard name={location.name} phone={location.phone} nearby={nearby.length} />
    </>
  );
}
