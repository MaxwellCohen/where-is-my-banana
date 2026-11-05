"use client";
import ReactPlayer from "react-player";

export default function VideoPlayer({ url, embed }: { url: string; embed?: string }) {
  return embed ? <iframe src={`https://www.youtube.com/embed/${embed}`} title="video" /> : <ReactPlayer url={url} />;
}
