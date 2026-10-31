import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Orbitron } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

const orbitron = Orbitron({
  variable: "--font-orbitron",
  subsets: ["latin"],
  weight: ["500", "700", "900"],
});

export const metadata: Metadata = {
  title: "API HUNTER // GitHub Recon Terminal",
  description:
    "24/7 GitHub recon system — auto-discovers working API endpoints (downloaders, AI chat/image/voice models) from recently-updated bot repos.",
  keywords: ["api hunter", "github recon", "api scanner", "whatsapp bot apis", "downloader apis", "ai apis"],
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%23020503'/%3E%3Ctext x='16' y='23' font-size='18' font-family='monospace' fill='%2300ff41' text-anchor='middle'%3E%3E_%3C/text%3E%3C/svg%3E",
  },
};

export const viewport: Viewport = {
  themeColor: "#020503",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${jetbrains.variable} ${orbitron.variable} antialiased`}
        style={{ background: "#020503" }}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
