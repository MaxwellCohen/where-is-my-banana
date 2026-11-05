export default function DoctorBio({ name, bio }: { name: string; bio: string }) {
  return (
    <article>
      <h2>{name}</h2>
      <p>{bio}</p>
    </article>
  );
}
