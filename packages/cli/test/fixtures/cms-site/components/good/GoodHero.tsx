import Image from "next/image";

export default function GoodHero({ title, src }: { title: string; src: string }) {
  return (
    <section>
      <Image src={`${src}?w=1600&fm=webp&q=75`} alt={title} width={1600} height={800} sizes="100vw" priority />
      <h1>{title}</h1>
    </section>
  );
}
