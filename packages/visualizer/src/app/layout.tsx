import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WIMB Bundle Forest",
  description: "Route-rooted Next.js analyze export visualizer",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
