import "./globals.css";
import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { ThemeProvider, themeScript } from "./components/ThemeProvider";
import { LinkTargetPolicy } from "./components/LinkTargetPolicy";

export const metadata: Metadata = {
  title: "Saturn",
  description: "Scheduled agent runs + interactive CLI chat",
  icons: {
    icon: "/icon.svg",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <head>
        {/*
          Inline theme-init script. Content is a module-level constant compiled from
          our own source code — no untrusted input — and must run before React hydrates
          so the page paints with the correct theme (no white flash in dark mode).
          This is the pattern recommended by the Next.js docs and next-themes.
        */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen antialiased">
        <ThemeProvider>
          <LinkTargetPolicy />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
