import { getService, getServiceSlugs } from "@/lib/good-cms";
import GoodVideo from "@/components/good/GoodVideo";
import GoodMapLoader from "@/components/good/GoodMapLoader";

export const revalidate = 86400;

export async function generateStaticParams() {
  return (await getServiceSlugs()).map((slug: string) => ({ slug }));
}

export default async function ServicePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const service = await getService(slug);
  return (
    <article>
      <h1>{service.title}</h1>
      <GoodVideo id={service.videoId} />
      <GoodMapLoader points={service.points} />
    </article>
  );
}
