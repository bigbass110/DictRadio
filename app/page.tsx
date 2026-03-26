/**
 * @file app/page.tsx
 * @description Page d'accueil de RadIA — tableau de bord des rapports récents.
 *
 * Cette page affiche :
 * - Un résumé des activités récentes du radiologue (rapports des 7 derniers jours)
 * - Un accès rapide à la création d'une nouvelle dictée
 * - Des statistiques rapides (nombre de rapports par statut et par modalité)
 *
 * La page est un Server Component Next.js (pas de "use client") pour les
 * données statiques. Les données Firestore sont chargées côté client via
 * un composant séparé `<DashboardClient>`.
 *
 * @module app/page
 */

import type { Metadata } from "next";
import Link from "next/link";

// ---------------------------------------------------------------------------
// Metadata de la page
// ---------------------------------------------------------------------------

/**
 * Metadata spécifique à la page d'accueil.
 * Surcharge les metadata globales définies dans `layout.tsx`.
 */
export const metadata: Metadata = {
  title: "Tableau de bord",
};

// ---------------------------------------------------------------------------
// Composant de page (Server Component)
// ---------------------------------------------------------------------------

/**
 * Page d'accueil — tableau de bord RadIA.
 *
 * Affiche un état de bienvenue statique et un lien vers la page de dictée.
 * Les données dynamiques (liste des rapports) seraient chargées via un
 * composant client dédié utilisant `onSnapshot` Firestore.
 */
export default function PageAccueil() {
  return (
    <div className="space-y-8">
      {/* En-tête de bienvenue */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Tableau de bord</h1>
          <p className="mt-1 text-gray-500">
            Bienvenue dans RadIA, votre assistant de transcription radiologique.
          </p>
        </div>
        <Link
          href="/dictation"
          className="px-6 py-3 bg-blue-600 text-white font-medium rounded-xl hover:bg-blue-700 transition-colors shadow-sm"
        >
          + Nouvelle dictée
        </Link>
      </div>

      {/* Cartes de statistiques rapides */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: "Rapports aujourd'hui", valeur: "—", couleur: "blue" },
          { label: "En attente de validation", valeur: "—", couleur: "orange" },
          { label: "Validés ce mois", valeur: "—", couleur: "green" },
        ].map((stat) => (
          <div
            key={stat.label}
            className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm"
          >
            <p className="text-sm text-gray-500">{stat.label}</p>
            <p className="mt-2 text-3xl font-bold text-gray-800">{stat.valeur}</p>
          </div>
        ))}
      </div>

      {/* Section rapports récents (placeholder) */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800">Rapports récents</h2>
        </div>
        <div className="p-12 text-center text-gray-400">
          <p className="text-lg">Aucun rapport récent.</p>
          <p className="mt-2 text-sm">
            Commencez par{" "}
            <Link href="/dictation" className="text-blue-600 hover:underline">
              créer votre première dictée
            </Link>
            .
          </p>
        </div>
      </div>

      {/* Description des fonctionnalités */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[
          {
            titre: "🎙️ Dictée audio",
            description:
              "Enregistrez votre dictée au microphone. Whisper la transcrit automatiquement en quelques secondes.",
          },
          {
            titre: "🏗️ Structuration IA",
            description:
              "RadPhi-3 organise votre texte en sections standardisées : Indication, Technique, Résultats, Conclusion.",
          },
          {
            titre: "🎯 Classification BI-RADS",
            description:
              "Attribution automatique du score ACR BI-RADS, TIRADS ou LI-RADS avec justification clinique.",
          },
          {
            titre: "📊 Comparaison antérieurs",
            description:
              "Gemini compare automatiquement votre rapport avec les examens précédents et liste les évolutions.",
          },
          {
            titre: "💬 Dr Vox",
            description:
              "Posez vos questions à l'assistant IA contextuel. Il s'appuie sur les guidelines ACR et SFR.",
          },
          {
            titre: "🔒 Confidentialité RGPD",
            description:
              "Données hébergées sur infrastructure GCP France. Conformité RGPD et secret médical garantis.",
          },
        ].map((feature) => (
          <div
            key={feature.titre}
            className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm hover:shadow-md transition-shadow"
          >
            <h3 className="font-semibold text-gray-800">{feature.titre}</h3>
            <p className="mt-2 text-sm text-gray-500 leading-relaxed">
              {feature.description}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
