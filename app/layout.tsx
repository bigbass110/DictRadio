/**
 * @file app/layout.tsx
 * @description Layout racine de l'application Next.js RadIA.
 *
 * Ce fichier définit le layout HTML de base partagé par toutes les pages :
 * - Balises `<html>` et `<body>` avec la langue française
 * - Police Inter (Google Fonts) chargée en optimized via `next/font`
 * - Provider de thème Tailwind (mode sombre potentiel)
 * - Metadata globale (titre, description, OpenGraph)
 * - Barre de navigation globale (NavBar)
 *
 * Le layout racine est rendu côté serveur (RSC) sauf pour les composants
 * client (NavBar, providers) qui sont importés avec `"use client"`.
 *
 * @module app/layout
 */

import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// ---------------------------------------------------------------------------
// Configuration de la police
// ---------------------------------------------------------------------------

/**
 * Configuration de la police Inter via `next/font/google`.
 *
 * `next/font` télécharge et héberge la police localement lors du build,
 * évitant les requêtes externes vers Google Fonts (performance + vie privée).
 *
 * Le `subsets: ["latin"]` inclut les caractères latins nécessaires au français.
 */
const inter = Inter({
  subsets: ["latin"],
  display: "swap", // "swap" évite le flash de texte invisible (FOIT)
  variable: "--font-inter", // Variable CSS utilisable dans Tailwind
});

// ---------------------------------------------------------------------------
// Metadata de l'application
// ---------------------------------------------------------------------------

/**
 * Metadata globale de l'application.
 * Utilisée par Next.js pour générer les balises `<meta>` et `<title>` de chaque page.
 * Chaque page peut surcharger ces valeurs via son propre export `metadata`.
 */
export const metadata: Metadata = {
  title: {
    default: "RadIA — Assistant de Transcription Radiologique",
    template: "%s | RadIA", // Format pour les pages : "Dictée | RadIA"
  },
  description:
    "RadIA transcrit et structure automatiquement vos dictées radiologiques " +
    "grâce à l'IA (Whisper, DrBERT, RadPhi-3, Gemini). " +
    "Rapports structurés, classification BI-RADS, comparaison avec antérieurs.",
  keywords: [
    "radiologie",
    "transcription",
    "compte rendu",
    "BI-RADS",
    "TIRADS",
    "intelligence artificielle",
    "Whisper",
    "Genkit",
  ],
  authors: [{ name: "RadIA Team" }],
  robots: "noindex, nofollow", // Application médicale confidentielle : pas d'indexation
};

// ---------------------------------------------------------------------------
// Composant Layout
// ---------------------------------------------------------------------------

/**
 * Layout racine de l'application.
 *
 * @param children - Les composants de page à rendre dans le layout.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr" className={inter.variable}>
      <body className="min-h-screen bg-gray-50 text-gray-900 antialiased">
        {/* Barre de navigation globale */}
        <nav
          className="sticky top-0 z-50 bg-white border-b border-gray-200 shadow-sm"
          aria-label="Navigation principale"
        >
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
            {/* Logo et titre */}
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-blue-700 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-sm">R</span>
              </div>
              <span className="font-semibold text-gray-900">RadIA</span>
              <span className="text-xs text-gray-400 hidden sm:block">
                Assistant de Transcription Radiologique
              </span>
            </div>

            {/* Actions de navigation */}
            <div className="flex items-center gap-4">
              <a
                href="/"
                className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
              >
                Tableau de bord
              </a>
              <a
                href="/dictation"
                className="text-sm px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                Nouvelle dictée
              </a>
            </div>
          </div>
        </nav>

        {/* Contenu principal */}
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {children}
        </main>

        {/* Pied de page */}
        <footer className="mt-16 py-6 border-t border-gray-200 text-center text-xs text-gray-400">
          <p>
            RadIA — Assistant de transcription radiologique.{" "}
            <strong>Non certifié comme dispositif médical.</strong> Usage réservé
            aux professionnels de santé qualifiés. Données hébergées conformément
            au RGPD.
          </p>
        </footer>
      </body>
    </html>
  );
}
