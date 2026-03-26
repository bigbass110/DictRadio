/**
 * @file functions/src/flows/biradsFlow.ts
 * @description Flow Genkit de classification BI-RADS (et équivalents) assistée par IA.
 *
 * Ce flow analyse le texte d'un rapport radiologique et attribue un score
 * de la classification standardisée correspondant à la modalité :
 *
 * | Modalité   | Classification | Scores |
 * |------------|---------------|--------|
 * | mammaire   | ACR BI-RADS   | 0–6    |
 * | thyroide   | ACR TIRADS    | 1–5    |
 * | abdomen    | LI-RADS (foie)| 1–5    |
 * | autre      | Texte libre   | N/A    |
 *
 * Le modèle utilisé est **Gemini 1.5 Pro** (via Genkit) avec un prompt
 * structuré incluant les critères officiels ACR pour chaque catégorie.
 * Gemini est préféré ici pour sa capacité de raisonnement multi-étapes
 * et sa familiarité avec les guidelines médicales anglaises/françaises.
 *
 * La réponse inclut :
 * - Le score numérique
 * - La catégorie textuelle (ex. "ACR 4B – Suspicion modérée")
 * - La recommandation clinique (ex. "Biopsie recommandée")
 * - La justification du score (chain-of-thought)
 *
 * @module functions/src/flows/biradsFlow
 */

import { defineFlow, run } from "@genkit-ai/flow";
import { gemini15Pro } from "@genkit-ai/googleai";
import { generate } from "@genkit-ai/ai";
import { z } from "zod";
import type {
  BiradsInput,
  BiradsOutput,
  ScoreBiRads,
  Modalite,
} from "../../../types/index.js";

// ---------------------------------------------------------------------------
// Schémas Zod
// ---------------------------------------------------------------------------

/** Schéma d'entrée pour le flow BI-RADS */
const BiradsInputSchema = z.object({
  /** Texte du rapport à analyser pour l'extraction du score */
  texte: z.string().min(1),
  /** Modalité : détermine quel système de classification appliquer */
  modalite: z.enum([
    "mammaire",
    "thyroide",
    "abdomen",
    "thorax",
    "crane",
    "musculosquelettique",
    "cardiaque",
    "autre",
  ]),
});

/** Schéma de sortie pour le flow BI-RADS */
const BiradsOutputSchema = z.object({
  biRads: z
    .object({
      score: z.number(),
      categorie: z.string(),
      recommandation: z.string(),
      systeme: z.enum(["BI-RADS", "TIRADS", "LI-RADS", "RENAL", "autre"]),
    })
    .nullable(),
  justification: z.string(),
});

// ---------------------------------------------------------------------------
// Définition du Flow
// ---------------------------------------------------------------------------

/**
 * Flow Genkit `biradsFlow`.
 *
 * Analyse un rapport radiologique et retourne le score BI-RADS (ou équivalent)
 * avec la recommandation clinique associée.
 *
 * Le flow retourne `biRads: null` pour les modalités qui n'ont pas de système
 * de classification structuré (thorax, crâne, musculo-squelettique).
 *
 * @example
 * const result = await httpsCallable(functions, "biradsFlow")({
 *   texte: "Nodule hypoéchogène de 12mm, contours irréguliers, lobe droit",
 *   modalite: "thyroide",
 * });
 * // result.data.biRads.score === 4
 * // result.data.biRads.systeme === "TIRADS"
 */
export const biradsFlow = defineFlow(
  {
    name: "biradsFlow",
    inputSchema: BiradsInputSchema,
    outputSchema: BiradsOutputSchema,
  },
  async (input: BiradsInput): Promise<BiradsOutput> => {
    // Vérifier si la modalité supporte une classification structurée
    if (!modaliteSupportsClassification(input.modalite)) {
      return {
        biRads: null,
        justification: `La modalité "${input.modalite}" n'a pas de système de classification standardisé supporté.`,
      };
    }

    // Déterminer le système de classification à utiliser
    const systeme = determinerSystemeClassification(input.modalite);

    // Exécuter la classification avec Gemini
    const resultat = await run("gemini-classification", async () => {
      return await classerAvecGemini(input.texte, input.modalite, systeme);
    });

    return resultat;
  }
);

// ---------------------------------------------------------------------------
// Fonctions utilitaires
// ---------------------------------------------------------------------------

/**
 * Vérifie si une modalité dispose d'un système de classification supporté.
 *
 * @param modalite - La modalité à vérifier.
 * @returns `true` si la modalité a un système de classification.
 */
function modaliteSupportsClassification(modalite: Modalite): boolean {
  const modalitesClassifiables: Modalite[] = ["mammaire", "thyroide", "abdomen"];
  return modalitesClassifiables.includes(modalite);
}

/**
 * Détermine le système de classification à appliquer selon la modalité.
 *
 * @param modalite - La modalité radiologique.
 * @returns Le système de classification approprié.
 */
function determinerSystemeClassification(
  modalite: Modalite
): ScoreBiRads["systeme"] {
  const mapping: Partial<Record<Modalite, ScoreBiRads["systeme"]>> = {
    mammaire: "BI-RADS",
    thyroide: "TIRADS",
    abdomen: "LI-RADS",
  };
  return mapping[modalite] ?? "autre";
}

/**
 * Construit le prompt de classification selon le système utilisé.
 *
 * Le prompt inclut les définitions officielles des catégories ACR pour
 * guider Gemini vers une classification précise et justifiée.
 *
 * @param texte - Le texte du rapport à classifier.
 * @param modalite - La modalité radiologique.
 * @param systeme - Le système de classification (BI-RADS, TIRADS, LI-RADS).
 * @returns Le prompt complet.
 */
function construirePromptClassification(
  texte: string,
  modalite: Modalite,
  systeme: ScoreBiRads["systeme"]
): string {
  // Définitions des catégories par système
  const categories: Record<string, string> = {
    "BI-RADS": `
ACR BI-RADS (mammographie/échographie mammaire) :
- 0 : Évaluation incomplète, examen complémentaire nécessaire
- 1 : Négatif – Surveillance annuelle de routine
- 2 : Bénin – Surveillance annuelle de routine
- 3 : Probablement bénin (<2% risque malignité) – Contrôle à 6 mois
- 4A : Faible suspicion (2-10%) – Biopsie à discuter
- 4B : Suspicion modérée (10-50%) – Biopsie recommandée
- 4C : Suspicion élevée (50-95%) – Biopsie recommandée
- 5 : Très probablement malin (>95%) – Biopsie obligatoire
- 6 : Malignité prouvée par biopsie`,
    TIRADS: `
ACR TIRADS (échographie thyroïdienne) :
- 1 : Bénin (0% risque) – Pas de biopsie
- 2 : Non suspect (0%) – Pas de biopsie
- 3 : Légèrement suspect (<5%) – FNA si ≥2,5cm
- 4 : Modérément suspect (5-20%) – FNA si ≥1,5cm
- 5 : Très suspect (>20%) – FNA si ≥1cm`,
    "LI-RADS": `
LI-RADS (foie, patients à risque CHC) :
- LR-1 : Certainement bénin
- LR-2 : Probablement bénin
- LR-3 : Intermédiaire
- LR-4 : Probablement CHC
- LR-5 : Certainement CHC`,
  };

  const categoriesTexte = categories[systeme] ?? "Classification standard";

  return `Tu es un radiologue expert en ${modalite}. 
Analyse ce rapport et attribue le score ${systeme} approprié.

Critères officiels :
${categoriesTexte}

Rapport à analyser :
${texte}

Réponds avec un JSON valide :
{
  "score": <nombre>,
  "categorie": "<catégorie complète, ex: ACR BI-RADS 3 – Probablement bénin>",
  "recommandation": "<recommandation clinique>",
  "justification": "<raisonnement étape par étape>"
}`;
}

/**
 * Classifie un rapport radiologique avec Gemini 1.5 Pro.
 *
 * Gemini Pro est préféré ici (vs Flash) car la classification BI-RADS
 * requiert un raisonnement multi-critères précis avec des implications
 * cliniques importantes.
 *
 * @param texte - Le texte du rapport.
 * @param modalite - La modalité radiologique.
 * @param systeme - Le système de classification.
 * @returns Le résultat de classification avec justification.
 */
async function classerAvecGemini(
  texte: string,
  modalite: Modalite,
  systeme: ScoreBiRads["systeme"]
): Promise<BiradsOutput> {
  const prompt = construirePromptClassification(texte, modalite, systeme);

  try {
    const response = await generate({
      model: gemini15Pro,
      prompt,
      config: {
        temperature: 0.1, // Très faible : la classification doit être déterministe
        maxOutputTokens: 512,
      },
    });

    const generatedText = response.text();

    // Parser la réponse JSON
    const jsonMatch = generatedText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Réponse Gemini non parseable");
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      score?: number;
      categorie?: string;
      recommandation?: string;
      justification?: string;
    };

    return {
      biRads: {
        score: parsed.score ?? 0,
        categorie: parsed.categorie ?? "Non déterminé",
        recommandation: parsed.recommandation ?? "Consulter un radiologue",
        systeme,
      },
      justification: parsed.justification ?? "",
    };
  } catch (error) {
    console.error("[biradsFlow] Erreur classification Gemini:", error);

    // En cas d'erreur, retourner un résultat indéterminé plutôt que de planter
    return {
      biRads: {
        score: 0,
        categorie: "Non déterminé – Erreur de classification",
        recommandation:
          "Évaluation manuelle recommandée en raison d'une erreur système.",
        systeme,
      },
      justification: `Erreur lors de la classification automatique : ${String(error)}`,
    };
  }
}
