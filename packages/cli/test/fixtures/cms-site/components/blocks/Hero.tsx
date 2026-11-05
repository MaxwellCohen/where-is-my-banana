import Image from "next/image";

export default function Hero({ title, image }: { title: string; image: { url: string; alt: string } }) {
  return (
    <section>
      <Image src={image.url} alt={image.alt} width={1600} height={800} />
      <h1>{title}</h1>
    </section>
  );
}
