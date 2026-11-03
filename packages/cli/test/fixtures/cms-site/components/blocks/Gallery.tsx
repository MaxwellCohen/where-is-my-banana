export default function Gallery({ photos }: { photos: { url: string; alt: string }[] }) {
  return (
    <div>
      {photos.map((p) => (
        <img key={p.url} src={p.url} alt={p.alt} />
      ))}
    </div>
  );
}
