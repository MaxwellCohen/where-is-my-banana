import Script from "next/script";
import type { ReactNode } from "react";
import { ContentfulLivePreviewProvider } from "@contentful/live-preview/react";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import "./globals.css";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link href="https://fonts.googleapis.com/css2?family=Lato:wght@400;700&display=swap" rel="stylesheet" />
        <Script id="gtm" src="https://www.googletagmanager.com/gtm.js?id=GTM-XXXX" />
        <Script src="https://cdn.cookielaw.org/scripttemplates/otSDKStub.js" strategy="beforeInteractive" data-domain-script="abc" />
        <Script id="chat" src="https://widget.intercom.io/widget/abc123" strategy="beforeInteractive" />
        <Script src="https://assets.calendly.com/assets/external/widget.js" strategy="afterInteractive" />
        <Script src="https://maps.googleapis.com/maps/api/js?key=KEY&libraries=places" strategy="afterInteractive" />
      </head>
      <body>
        <ContentfulLivePreviewProvider locale="en-US">
          <Header />
          {children}
          <Footer />
        </ContentfulLivePreviewProvider>
      </body>
    </html>
  );
}
