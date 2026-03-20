import "./globals.css";

export const metadata = {
  title: "Listing Manager — Driven Brands",
  description: "Semrush Listing Management API Bridge",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
