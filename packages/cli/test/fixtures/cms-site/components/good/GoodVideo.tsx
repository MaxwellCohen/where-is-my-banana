export default function GoodVideo({ id }: { id: string }) {
  return <iframe src={`https://www.youtube.com/embed/${id}`} title="video" loading="lazy" />;
}
