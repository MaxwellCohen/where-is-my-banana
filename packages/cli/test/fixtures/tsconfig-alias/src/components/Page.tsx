"use client";

import { HomeContent } from "./HomeContent";

export function Page({ pathname }: { pathname: string }) {
  const isHomePage = pathname === "/";
  let content;
  if (isHomePage) {
    content = <HomeContent />;
  } else {
    content = <div>Other</div>;
  }
  return <main>{content}</main>;
}
