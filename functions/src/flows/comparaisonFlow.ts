/**
 * @file functions/src/flows/comparaisonFlow.ts
 * @description Flow Genkit de comparaison d'un rapport avec les antérieurs.
 *
 * Ce flow compare deux rapports radiologiques (nouveau et antérieur) pour
 * mettre en évidence les évolutions lésionnelles entre les deux examens.
 *
 * Cas d'usage typique :
 * - Suivi d'un nodule thyroïdien (TIRADS 3, contrôle à 1 an)
 * - Évolution d'un nodule mammaire (ACR 3 → ACR 4 ?)
 * - Surveillance post-thérapeutique (régression/progression tumorale)
 * - Suivi de métastases hépatiques sous chimiothérapie
 *
 * La comparaison est effectuée par **Gemini 1.5 Pro** qui :
 * 1. Identifie les lésions décrites dans les deux rapports
 * 2. Met en correspondance les lésions par localisation et caractéristiques
 * 3. Évalue l'évolution de chaque lésion (stable, augmentation, diminution,
 *    nouvelle, disparue)
 * 4. Génère un résumé synthétique en français médical
 * 5. Signale les aggravations potentiellement significatives
 *
 * Le résultat est intégré dans l'éditeur de rapport comme section
 * "Comparaison avec antérieur" et sauvegardé dans Firestore.
 *
 * @module functions/src/flows/comparaisonFlow
 */

import { defineFlow, run } from "@genkit-ai/flow";
import { gemini15Pro } from "@genkit-ai/googleai";
import { generate } from "@genkit-ai/ai";
import { z } from "zod";
import type {
  ComparaisonInput,
  ComparaisonOutput,
  SectionsRapport,
  Modalite,
} from "../../../types/index.js";

// ---------------------------------------------------------------------------
// Schémas Zod
// ---------------------------------------------------------------------------

/** Schéma d'une section de rapport pour la validation */
const SectionsSchema = z.object({
  indication: z.string(),
  technique: z.string(),
  resultats: z.string(),
  conclusion: z.string(),
});

/** Schéma d'entrée du flow de comparaison */
const ComparaisonInputSchema = z.object({
  nouveauRapport: SectionsSchema,
  rapportAnterieur: SectionsSchema,
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

/** Schéma de sortie du flow de comparaison */
const ComparaisonOutputSchema = z.object({
  evolution: z.string(),
  aggravationDetectee: z.boolean(),
  lesions: z.array(
    z.object({
      description: z.string(),
      evolution: z.enum([
        "stable",
        "augmentation",
        "diminution",
        "nouvelle",
        "disparue",
      ]),
    })
  ),
});

// ---------------------------------------------------------------------------
// Définition du Flow
// ---------------------------------------------------------------------------

/**
 * Flow Genkit `comparaisonFlow`.
 *
 * Compare deux rapports radiologiques et génère un résumé d'évolution.
 *
 * @example
 * const result = await httpsCallable(functions, "comparaisonFlow")({
 *   nouveauRapport: { indication: "...", technique: "...", resultats: "...", conclusion: "..." },
 *   rapportAnterieur: { indication: "...", technique: "...", resultats: "...", conclusion: "..." },
 *   modalite: "thyroide",
 * });
 * // result.data.evolution === "Le nodule du lobe droit a augmenté de 8mm à 12mm..."
 * // result.data.aggravationDetectee === true
 */
export const comparaisonFlow = defineFlow(
  {
    name: "comparaisonFlow",
    inputSchema: ComparaisonInputSchema,
    outputSchema: ComparaisonOutputSchema,
  },
  async (input: ComparaisonInput): Promise<ComparaisonOutput> => {
    const resultat = await run("gemini-comparaison", async () => {
      return await comparerAvecGemini(
        input.nouveauRapport,
        input.rapportAnterieur,
        input.modalite
      );
    });

    return resultat;
  }
);

// ---------------------------------------------------------------------------
// Fonctions utilitaires
// ---------------------------------------------------------------------------

/**
 * Construit le prompt de comparaison pour Gemini.
 *
 * Le prompt est structuré pour guider Gemini vers une analyse lésion
 * par lésion plutôt qu'une comparaison globale, ce qui est plus utile
 * cliniquement pour le radiologue.
 *
 * @param nouveauRapport - Sections du rapport actuel.
 * @param rapportAnterieur - Sections du rapport de référence.
 * @param modalite - Modalité pour contextualiser la comparaison.
 * @returns Le prompt complet.
 */
function construirePromptComparaison(
  nouveauRapport: SectionsRapport,
  rapportAnterieur: SectionsRapport,
  modalite: Modalite
): string {
  // Formater chaque rapport en texte continu pour le prompt
  const formatRapport = (sections: SectionsRapport): string =>
    `Indication: ${sections.indication}\n` +
    `Technique: ${sections.technique}\n` +
    `Résultats: ${sections.resultats}\n` +
    `Conclusion: ${sections.conclusion}`;

  return `Tu es un radiologue expert spécialisé en ${modalite}.
Compare ces deux rapports radiologiques et identifie les évolutions lésionnelles.

=== RAPPORT ANTÉRIEUR ===
${formatRapport(rapportAnterieur)}

=== RAPPORT ACTUEL ===
${formatRapport(nouveauRapport)}

Instructions :
1. Identifie chaque lésion mentionnée dans l'un ou l'autre rapport
2. Pour chaque lésion, évalue l'évolution : stable / augmentation / diminution / nouvelle / disparue
3. Génère un résumé clinique concis des évolutions principales
4. Indique si une aggravation significative a été détectée (nécessitant une action urgente)

Réponds avec un JSON valide :
{
  "evolution": "<résumé de l'évolution en 2-3 phrases médicales>",
  "aggravationDetectee": <true/false>,
  "lesions": [
    {
      "description": "<description de la lésion + localisation>",
      "evolution": "<stable|augmentation|diminution|nouvelle|disparue>"
    }
  ]
}`;
}

/**
 * Compare deux rapports radiologiques avec Gemini 1.5 Pro.
 *
 * En cas d'erreur (API, parsing), retourne une réponse de fallback
 * indiquant que la comparaison n'a pas pu être effectuée, sans perdre
 * les données du rapport principal.
 *
 * @param nouveauRapport - Sections du nouveau rapport.
 * @param rapportAnterieur - Sections du rapport antérieur.
 * @param modalite - Modalité radiologique.
 * @returns Le résultat de comparaison structuré.
 */
async function comparerAvecGemini(
  nouveauRapport: SectionsRapport,
  rapportAnterieur: SectionsRapport,
  modalite: Modalite
): Promise<ComparaisonOutput> {
  const prompt = construirePromptComparaison(
    nouveauRapport,
    rapportAnterieur,
    modalite
  );

  try {
    const response = await generate({
      model: gemini15Pro,
      prompt,
      config: {
        temperature: 0.2,
        maxOutputTokens: 1024,
      },
    });

    const generatedText = response.text();

    // Extraire le JSON de la réponse
    const jsonMatch = generatedText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Réponse Gemini non parseable");
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      evolution?: string;
      aggravationDetectee?: boolean;
      lesions?: Array<{ description: string; evolution: string }>;
    };

    // Valider et normaliser les données parsées
    const lesionsValides = (parsed.lesions ?? [])
      .filter(
        (l) =>
          l.description &&
          [
            "stable",
            "augmentation",
            "diminution",
            "nouvelle",
            "disparue",
          ].includes(l.evolution)
      )
      .map((l) => ({
        description: l.description,
        evolution: l.evolution as ComparaisonOutput["lesions"][0]["evolution"],
      }));

    return {
      evolution:
        parsed.evolution ?? "Comparaison effectuée — voir le rapport pour les détails.",
      aggravationDetectee: parsed.aggravationDetectee ?? false,
      lesions: lesionsValides,
    };
  } catch (error) {
    console.error("[comparaisonFlow] Erreur Gemini:", error);

    // Fallback : retourner une réponse minimale sans planter le pipeline
    return {
      evolution:
        "La comparaison automatique avec le rapport antérieur n'a pas pu être effectuée. " +
        "Veuillez comparer manuellement avec le rapport précédent.",
      aggravationDetectee: false,
      lesions: [],
    };
  }
}
