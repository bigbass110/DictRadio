/**
 * @file tailwind.config.ts
 * @description Configuration Tailwind CSS pour RadIA.
 *
 * Configure les chemins de purge des classes CSS inutilisées et
 * étend le thème par défaut avec les couleurs de la charte RadIA.
 */

import type { Config } from "tailwindcss";

const config: Config = {
  // Chemins des fichiers contenant des classes Tailwind
  // Tailwind analyse ces fichiers pour n'inclure que les classes utilisées
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // Police Inter comme police principale
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "system-ui", "sans-serif"],
      },
      // Couleurs de la charte RadIA (bleu médical)
      colors: {
        radia: {
          50: "#eff6ff",
          100: "#dbeafe",
          500: "#3b82f6",
          600: "#2563eb",
          700: "#1d4ed8",
          900: "#1e3a8a",
        },
      },
    },
  },
  plugins: [],
};

export default config;
