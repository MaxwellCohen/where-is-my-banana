import Script from "next/script";
import dynamic from "next/dynamic";
import { draftMode } from "next/headers";
import type { ReactNode } from "react";

const LivePreview = dynamic(() => import("@contentful/live-preview/react").then((m) => m.ContentfulLivePreviewProvider));

export default async function GoodLayout({ children }: { children: ReactNode }) {
  const { isEnabled } = await draftMode();
  return (
    <>
      <Script id="gtm-good" src="https://www.googletagmanager.com/gtm.js?id=GTM-YYYY" strategy="lazyOnload" />
      <Script src="https://cdn.cookielaw.org/scripttemplates/otSDKStub.js" strategy="afterInteractive" />
      {isEnabled ? <LivePreview locale="en-US">{children}</LivePreview> : children}
    </>
  );
}
