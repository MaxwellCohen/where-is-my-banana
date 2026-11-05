export default function BlogList({ posts }: { posts: { slug: string; title: string }[] }) {
  return <ul>{posts.map((p) => <li key={p.slug}><a href={`/blog/${p.slug}`}>{p.title}</a></li>)}</ul>;
}
