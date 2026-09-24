import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Battle Bus",
  description: "Durable commerce integration engine",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
