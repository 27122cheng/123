import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        dark: {
          900: "#0a0e1a",
          800: "#0f1629",
          700: "#141d35",
          600: "#1a2444",
          500: "#1e2a4a",
        },
        accent: {
          blue: "#3b82f6",
          cyan: "#06b6d4",
        },
      },
    },
  },
  plugins: [],
};

export default config;
