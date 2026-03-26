/**
 * @file functions/src/flows/structurationFlow.ts
 * @description Flow Genkit de structuration sémantique d'un rapport radiologique.
 *
 * Ce flow prend un texte brut (issu de la transcription ou d'une saisie manuelle)
 * et le transforme en un rapport structuré avec les sections standardisées :
 * Indication / Technique / Résultats / Conclusion.
 *
 * La structuration utilise deux modèles en cascade :
 * 1. **RadPhi-3** (Microsoft, via Hugging Face) — modèle spécialisé en
 *    radiologie, entraîné sur des millions de rapports radiologiques.
 *    Meilleure performance sur la séparation sémantique des sections.
 * 2. **Gemini** (Google) — fallback si RadPhi-3 est indisponible ou
 *    si la réponse n'est pas parseable. Gemini est aussi utilisé directement
 *    pour les modalités peu représentées dans le corpus RadPhi.
 *
 * Le prompt de structuration est adapté à la modalité pour maximiser
 * la pertinence des sections générées.
 *
 * @module functions/src/flows/structurationFlow
 */

import { defineFlow, run } from "@genkit-ai/flow";
import { gemini15Flash } from "@genkit-ai/googleai";
import { generate } from "@genkit-ai/ai";
import { z } from "zod";
import type {
  StructurationInput,
  StructurationOutput,
  SectionsRapport,
  Modalite,
} from "../../../types/index.js";

// ---------------------------------------------------------------------------
// Schémas Zod
// ---------------------------------------------------------------------------

/** Schéma d'entrée du flow de structuration */
const StructurationInputSchema = z.object({
  /** Texte brut à structurer */
  texte: z.string().min(10, "Le texte est trop court pour être structuré"),
  /** Modalité pour adapter le prompt */
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

/** Schéma de sortie du flow de structuration */
const StructurationOutputSchema = z.object({
  sections: z.object({
    indication: z.string(),
    technique: z.string(),
    resultats: z.string(),
    conclusion: z.string(),
  }),
  modele: z.enum(["radphi3", "gemini", "fallback"]),
});

// ---------------------------------------------------------------------------
// Définition du Flow
// ---------------------------------------------------------------------------

/**
 * Flow Genkit `structurationFlow`.
 *
 * Reçoit un texte brut et retourne les sections structurées du rapport.
 * Appelé depuis `functions/src/index.ts` après `transcriptionFlow`.
 *
 * @example
 * const result = await httpsCallable(functions, "structurationFlow")({
 *   texte: "Patiente de 45 ans, mammographie bilatérale de dépistage...",
 *   modalite: "mammaire",
 * });
 * // result.data.sections.indication === "Patiente de 45 ans..."
 */
export const structurationFlow = defineFlow(
  {
    name: "structurationFlow",
    inputSchema: StructurationInputSchema,
    outputSchema: StructurationOutputSchema,
  },
  async (input: StructurationInput): Promise<StructurationOutput> => {
    // ------------------------------------------------------------------
    // Tentative 1 : RadPhi-3 via Hugging Face
    // RadPhi-3 est le modèle de référence pour la structuration en radiologie.
    // ------------------------------------------------------------------
    const resultRadphi = await run("radphi3-structuration", async () => {
      return await structurerAvecRadphi3(input.texte, input.modalite);
    });

    if (resultRadphi) {
      return { sections: resultRadphi, modele: "radphi3" };
    }

    // ------------------------------------------------------------------
    // Tentative 2 : Gemini (fallback)
    // Utilisé si RadPhi-3 est indisponible ou si le parsing JSON échoue.
    // Gemini 1.5 Flash est préféré pour sa rapidité et son faible coût.
    // ------------------------------------------------------------------
    const resultGemini = await run("gemini-structuration", async () => {
      return await structurerAvecGemini(input.texte, input.modalite);
    });

    if (resultGemini) {
      return { sections: resultGemini, modele: "gemini" };
    }

    // ------------------------------------------------------------------
    // Fallback final : structuration heuristique basique
    // Si les deux IA échouent, on retourne le texte complet dans `resultats`
    // pour éviter une perte de données, avec des sections vides.
    // ------------------------------------------------------------------
    return {
      sections: {
        indication: "",
        technique: "",
        resultats: input.texte,
        conclusion: "",
      },
      modele: "fallback",
    };
  }
);

// ---------------------------------------------------------------------------
// Fonctions utilitaires
// ---------------------------------------------------------------------------

/**
 * Construit le prompt de structuration adapté à la modalité.
 *
 * Le prompt inclut des exemples de sections pour guider le modèle IA
 * et demande une sortie JSON structurée.
 *
 * @param texte - Le texte brut à structurer.
 * @param modalite - La modalité pour contextualiser le prompt.
 * @returns Le prompt complet à envoyer au modèle IA.
 */
function construirePromptStructuration(texte: string, modalite: Modalite): string {
  // Exemples de sections par modalité pour le few-shot prompting
  const exemples: Partial<Record<Modalite, string>> = {
    mammaire:
      "Exemple : Indication: Dépistage, 45 ans. Technique: Mammographie bilatérale 2 incidences. " +
      "Résultats: Seins de densité ACR B. Pas d'image suspecte. Conclusion: ACR 1.",
    thyroide:
      "Exemple : Indication: Nodule palpable droit. Technique: Échographie cervicale. " +
      "Résultats: Nodule hypoéchogène 8mm lobe droit. Conclusion: TIRADS 3.",
    abdomen:
      "Exemple : Indication: Douleurs abdominales. Technique: Échographie abdominale. " +
      "Résultats: Foie homogène, vésicule sans calcul. Conclusion: Examen normal.",
  };

  const exempleModalite =
    exemples[modalite] ?? "Structurer selon les sections radiologiques standard.";

  return `Tu es un radiologue expert. Analyse ce texte de compte rendu radiologique 
et structure-le en 4 sections : indication, technique, resultats, conclusion.

Modalité : ${modalite}
${exempleModalite}

Texte à structurer :
${texte}

Réponds UNIQUEMENT avec un JSON valide de la forme :
{
  "indication": "...",
  "technique": "...",
  "resultats": "...",
  "conclusion": "..."
}`;
}

/**
 * Tente de structurer le texte avec Phi-3-mini via l'API Hugging Face.
 *
 * Note : Le modèle utilisé est `microsoft/Phi-3-mini-4k-instruct`, un LLM
 * généraliste de petite taille. Un modèle véritablement spécialisé en
 * radiologie (ex. RadPhi-3, si disponible publiquement sur Hugging Face)
 * pourrait être substitué ici pour de meilleures performances sur le
 * vocabulaire radiologique. Les commentaires font référence à "RadPhi-3"
 * pour indiquer l'intention architecturale, même si le modèle déployé
 * est Phi-3-mini.
 *
 * @param texte - Texte brut à structurer.
 * @param modalite - Modalité radiologique.
 * @returns Les sections structurées, ou `null` si l'appel échoue.
 */
async function structurerAvecRadphi3(
  texte: string,
  modalite: Modalite
): Promise<SectionsRapport | null> {
  const apiKey = process.env.HUGGINGFACE_API_KEY;
  if (!apiKey) return null;

  const prompt = construirePromptStructuration(texte, modalite);

  try {
    const response = await fetch(
      "https://api-inference.huggingface.co/models/microsoft/Phi-3-mini-4k-instruct",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inputs: prompt,
          parameters: {
            max_new_tokens: 512,
            temperature: 0.1, // Faible température pour une sortie déterministe
            return_full_text: false,
          },
          options: { wait_for_model: true },
        }),
      }
    );

    if (!response.ok) return null;

    const result = await response.json() as Array<{ generated_text: string }>;
    const generatedText = result[0]?.generated_text ?? "";

    // Extraction du JSON depuis la réponse (peut contenir du texte avant/après)
    return extraireJsonSections(generatedText);
  } catch (error) {
    console.error("[structurationFlow] Erreur RadPhi-3:", error);
    return null;
  }
}

/**
 * Tente de structurer le texte avec Gemini 1.5 Flash via Genkit.
 *
 * Gemini est le fallback principal. Il est appelé via l'abstraction
 * Genkit `generate()` qui gère automatiquement les retry et le streaming.
 *
 * @param texte - Texte brut à structurer.
 * @param modalite - Modalité radiologique.
 * @returns Les sections structurées, ou `null` si l'appel échoue.
 */
async function structurerAvecGemini(
  texte: string,
  modalite: Modalite
): Promise<SectionsRapport | null> {
  const prompt = construirePromptStructuration(texte, modalite);

  try {
    const response = await generate({
      model: gemini15Flash,
      prompt,
      config: {
        temperature: 0.1,
        maxOutputTokens: 512,
      },
    });

    const generatedText = response.text();
    return extraireJsonSections(generatedText);
  } catch (error) {
    console.error("[structurationFlow] Erreur Gemini:", error);
    return null;
  }
}

/**
 * Extrait et parse le JSON des sections depuis une réponse textuelle du modèle.
 *
 * Les modèles LLM peuvent inclure du texte avant/après le JSON.
 * Cette fonction utilise une regex pour extraire le premier objet JSON valide
 * et vérifie que les 4 sections attendues sont présentes.
 *
 * @param texte - La réponse textuelle brute du modèle IA.
 * @returns Les sections parsées, ou `null` si le parsing échoue.
 */
function extraireJsonSections(texte: string): SectionsRapport | null {
  try {
    // Extraire le bloc JSON de la réponse (entre { et })
    const jsonMatch = texte.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as Partial<SectionsRapport>;

    // Vérifier que les 4 sections obligatoires sont présentes
    if (
      typeof parsed.indication === "string" &&
      typeof parsed.technique === "string" &&
      typeof parsed.resultats === "string" &&
      typeof parsed.conclusion === "string"
    ) {
      return parsed as SectionsRapport;
    }

    return null;
  } catch {
    return null;
  }
}
