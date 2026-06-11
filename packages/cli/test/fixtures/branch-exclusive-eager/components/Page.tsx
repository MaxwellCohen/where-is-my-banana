"use client";

import { HomeContent } from "./HomeContent";

export function Page({ pathname }: { pathname: string }) {
  const cleanedPath = pathname.split(/[?#]/)[0];
  const isHomePage = cleanedPath === "/";

  let content;
  if (isHomePage) {
    content = <HomeContent />;
  } else {
    content = <div>Other pages</div>;
  }

  return <main>{content}</main>;
}
