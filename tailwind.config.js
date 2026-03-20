/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          0: "#111113",
          1: "#151517",
          2: "#1a1a1d",
          3: "#1c1c1f",
          4: "#222225",
          5: "#2a2a2e",
        },
        brand: {
          carstar: "#E31837",
          take5: "#0066CC",
          autoglass: "#00875A",
        },
      },
      fontFamily: {
        sans: ['"DM Sans"', '"Segoe UI"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "monospace"],
      },
    },
  },
  plugins: [],
};
