import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "XARB — Binance→Polymarket Latency Arb Terminal",
  description:
    "Live cross-exchange latency arbitrage terminal: Binance BTCUSDT leads, Polymarket 5-minute BTC UP/DOWN lags. Fair-value engine, trigger detection, paper execution, sub-millisecond decision path.",
  keywords: [
    "arbitrage",
    "Polymarket",
    "Binance",
    "BTC",
    "latency",
    "trading terminal",
    "binary markets",
  ],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-[#0b0d11] text-zinc-100`}
      >
        {children}
        <Toaster
          theme="dark"
          position="bottom-right"
          toastOptions={{
            style: {
              background: "#12151b",
              border: "1px solid #262b33",
              color: "#e4e4e7",
              fontFamily: "var(--font-geist-mono), monospace",
            },
          }}
        />
      </body>
    </html>
  );
}
