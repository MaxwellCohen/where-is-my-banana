import { documentToReactComponents } from "@contentful/rich-text-react-renderer";

export default function RichText({ doc }: { doc: any }) {
  return (
    <div>
      {documentToReactComponents(doc)}
      <img src="https://images.ctfassets.net/abc123/inline/4d2a/before-after.jpg" alt="Before and after" />
    </div>
  );
}
