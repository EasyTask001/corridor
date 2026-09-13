import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { Plus_Jakarta_Sans } from "next/font/google";
import { THEME_STORAGE_KEY, TooltipProvider } from "@corridor/ui";
import "./globals.css";

/**
 * Self-hosted by Next (no render-blocking Google Fonts request, no layout
 * shift). Exposes `--font-sans-loaded`, which `@corridor/ui`'s
 * `tokens.css` wraps with a system-font fallback — see the spec's
 * Typography section for why Plus Jakarta Sans.
 */
const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans-loaded",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Corridor", template: "%s · Corridor" },
  description: "AI-native cross-border customs compliance for carriers.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * Sets `data-theme` before paint so a stored dark-mode preference doesn't
 * flash light first. Runs inline, not via next/script, because it must
 * execute before the first paint of `<body>`.
 */
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t;}}catch(e){}})();`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" className={plusJakartaSans.variable} suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full">
        <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
      </body>
    </html>
  );
}
