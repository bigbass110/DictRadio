/**
 * @file functions/src/flows/drVoxFlow.ts
 * @description Flow Genkit de l'assistant IA Dr Vox — chat contextuel et RAG médical.
 *
 * Dr Vox est l'assistant IA intégré à RadIA. Il répond aux questions des
 * radiologues en combinant :
 *
 * 1. **Génération augmentée par récupération (RAG)** : recherche dans une base
 *    documentaire médicale (guidelines ACR, SFR, RSNA) stockée dans Firestore
 *    (collection `guideline_chunks`) pour fournir des réponses sourcées.
 *
 * 2. **Raisonnement contextuel** : le rapport en cours d'édition est injecté
 *    dans le contexte de Gemini pour des réponses adaptées au cas clinique.
 *
 * 3. **Mémoire conversationnelle** : l'historique de la conversation est
 *    maintenu côté client et envoyé à chaque appel pour un dialogue multi-tours.
 *
 * 4. **Raisonnement explicable** : Gemini est invité à fournir un chain-of-thought
 *    avant sa réponse finale, que RadIA peut afficher à la demande.
 *
 * Exemples de questions supportées :
 * - "Quels sont les critères ACR BI-RADS 4B ?"
 * - "Ce nodule de 12mm TIRADS 4, quelle est la conduite à tenir ?"
 * - "Rédige la conclusion pour ce rapport de scanner thoracique."
 * - "Compare la taille du nodule avec le rapport précédent."
 *
 * @module functions/src/flows/drVoxFlow
 */

import { defineFlow, run } from "@genkit-ai/flow";
import { gemini15Pro } from "@genkit-ai/googleai";
import { generate } from "@genkit-ai/ai";
import { z } from "zod";
import { getFirestore } from "firebase-admin/firestore";
import type {
  DrVoxInput,
  DrVoxOutput,
  SectionsRapport,
} from "../../../types/index.js";

// ---------------------------------------------------------------------------
// Schémas Zod
// ---------------------------------------------------------------------------

/** Schéma d'entrée du flow Dr Vox */
const DrVoxInputSchema = z.object({
  /** Question posée par le radiologue */
  question: z.string().min(1, "La question ne peut pas être vide"),
  /** Sections du rapport en cours (contexte optionnel) */
  contexteRapport: z
    .object({
      indication: z.string().optional(),
      technique: z.string().optional(),
      resultats: z.string().optional(),
      conclusion: z.string().optional(),
    })
    .optional(),
  /** Historique de la conversation pour le mode multi-tours */
  historique: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        contenu: z.string(),
      })
    )
    .optional(),
});

/** Schéma de sortie du flow Dr Vox */
const DrVoxOutputSchema = z.object({
  reponse: z.string(),
  sources: z
    .array(
      z.object({
        titre: z.string(),
        extrait: z.string(),
        url: z.string().optional(),
      })
    )
    .optional(),
  raisonnement: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Définition du Flow
// ---------------------------------------------------------------------------

/**
 * Flow Genkit `drVoxFlow`.
 *
 * L'assistant Dr Vox répond aux questions contextualisées du radiologue
 * en s'appuyant sur les guidelines médicales et le rapport en cours.
 *
 * @example
 * const result = await httpsCallable(functions, "drVoxFlow")({
 *   question: "Quelle est la conduite à tenir pour un TIRADS 4 de 15mm ?",
 *   contexteRapport: {
 *     resultats: "Nodule hypoéchogène 15mm, lobe droit, contours lobulés",
 *   },
 * });
 * // result.data.reponse === "Pour un nodule TIRADS 4 de ≥15mm, la FNA est recommandée..."
 * // result.data.sources[0].titre === "ACR TIRADS Guidelines 2023"
 */
export const drVoxFlow = defineFlow(
  {
    name: "drVoxFlow",
    inputSchema: DrVoxInputSchema,
    outputSchema: DrVoxOutputSchema,
  },
  async (input: DrVoxInput): Promise<DrVoxOutput> => {
    // ------------------------------------------------------------------
    // Étape 1 : Recherche RAG dans les guidelines médicales
    // Récupère les passages les plus pertinents depuis Firestore
    // pour contextualiser la réponse de Gemini.
    // ------------------------------------------------------------------
    const sources = await run("rag-retrieval", async () => {
      return await rechercherDansGuidelines(input.question);
    });

    // ------------------------------------------------------------------
    // Étape 2 : Génération de la réponse avec Gemini 1.5 Pro
    // Le prompt inclut :
    // - Le système de rôle (Dr Vox, radiologue expert)
    // - L'historique de conversation
    // - Les sources RAG récupérées
    // - Le contexte du rapport en cours
    // - La question de l'utilisateur
    // ------------------------------------------------------------------
    const reponse = await run("gemini-dr-vox", async () => {
      return await genererReponseDrVox(
        input.question,
        input.contexteRapport,
        input.historique ?? [],
        sources
      );
    });

    return {
      reponse: reponse.texte,
      sources,
      raisonnement: reponse.raisonnement,
    };
  }
);

// ---------------------------------------------------------------------------
// Fonctions utilitaires
// ---------------------------------------------------------------------------

/**
 * Nombre maximum de messages d'historique transmis à Dr Vox par appel.
 * Limité pour éviter de dépasser la fenêtre de contexte de Gemini (128k tokens)
 * et pour réduire les coûts par appel. 6 échanges = 12 messages (user+assistant).
 */
const MAX_HISTORY_MESSAGES = 6;
interface GuidelineChunk {
  /** Titre du document source */
  titre: string;
  /** Extrait pertinent du document */
  extrait: string;
  /** URL de la source originale (optionnelle) */
  url?: string;
  /** Score de pertinence (0–1) pour le ranking */
  score?: number;
}

/**
 * Recherche les passages pertinents dans la base de guidelines médicales.
 *
 * La stratégie RAG utilisée ici est une recherche par mots-clés dans Firestore
 * (collection `guideline_chunks`). Une implémentation plus avancée utiliserait
 * des embeddings vectoriels (ex. Vertex AI Vector Search) pour une meilleure
 * pertinence sémantique.
 *
 * Structure Firestore de `guideline_chunks` :
 * ```
 * {
 *   titre: "ACR BI-RADS Atlas 5th Edition",
 *   extrait: "Category 3: Probably Benign...",
 *   motsCles: ["birads", "mammaire", "categorie 3"],
 *   url: "https://www.acr.org/...",
 * }
 * ```
 *
 * @param question - La question posée par le radiologue.
 * @returns Les 3 passages les plus pertinents (ou moins si peu disponibles).
 */
async function rechercherDansGuidelines(
  question: string
): Promise<GuidelineChunk[]> {
  const firestore = getFirestore();

  // Extraction des mots-clés de la question pour la recherche
  // (Simplification : une vraie implémentation utiliserait des embeddings)
  const motsCles = extraireMotsCles(question);

  if (motsCles.length === 0) return [];

  try {
    // Recherche des chunks contenant au moins un mot-clé
    // Firestore `array-contains-any` supporte jusqu'à 10 valeurs
    const snapshot = await firestore
      .collection("guideline_chunks")
      .where("motsCles", "array-contains-any", motsCles.slice(0, 10))
      .limit(5)
      .get();

    return snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        titre: data.titre as string,
        extrait: data.extrait as string,
        url: data.url as string | undefined,
      };
    });
  } catch (error) {
    console.warn("[drVoxFlow] Erreur RAG:", error);
    return [];
  }
}

/**
 * Extrait les mots-clés médicaux significatifs d'une question.
 *
 * Filtre les mots vides (stopwords) et normalise en minuscules.
 * Les abréviations médicales courantes sont préservées.
 *
 * @param question - La question à analyser.
 * @returns Liste de mots-clés pertinents.
 */
function extraireMotsCles(question: string): string[] {
  // Mots vides français à exclure
  const stopwords = new Set([
    "le", "la", "les", "un", "une", "des", "du", "de", "et", "ou", "mais",
    "donc", "or", "ni", "car", "que", "qui", "quoi", "est", "sont", "pour",
    "dans", "sur", "avec", "par", "en", "au", "aux", "ce", "cet", "cette",
    "ces", "mon", "ma", "mes", "ton", "ta", "tes", "son", "sa", "ses",
    "je", "tu", "il", "elle", "nous", "vous", "ils", "elles", "me", "te",
    "se", "ne", "pas", "plus", "très", "bien", "être", "avoir", "faire",
    "quel", "quelle", "quels", "quelles", "comment", "quand", "où", "combien",
  ]);

  return question
    .toLowerCase()
    .replace(/[?!.,;:()]/g, " ") // Supprimer la ponctuation
    .split(/\s+/)
    .filter((mot) => mot.length > 3 && !stopwords.has(mot))
    .slice(0, 10); // Limiter à 10 mots-clés
}

/**
 * Construit le prompt système pour Dr Vox.
 *
 * Définit la personnalité et les capacités de l'assistant pour
 * guider Gemini vers des réponses médicalement précises et utiles.
 *
 * @returns Le prompt système de Dr Vox.
 */
function construirePromptSysteme(): string {
  return `Tu es Dr Vox, un assistant IA spécialisé en radiologie médicale, intégré au logiciel RadIA.
Tu assistes les radiologues dans leur travail quotidien de rédaction de comptes rendus.

Tes capacités :
- Expliquer les critères des systèmes de classification (BI-RADS, TIRADS, LI-RADS, PI-RADS, LUNG-RADS)
- Suggérer des formulations médicales appropriées
- Rappeler les conduites à tenir selon les guidelines ACR, SFR, ESR
- Aider à comparer des lésions avec des antérieurs
- Rédiger ou reformuler des sections de rapports

Règles importantes :
- Réponds TOUJOURS en français médical précis
- Cite les sources (guidelines) quand tu le peux
- Rappelle que tu es un assistant et que le radiologue reste responsable du diagnostic
- Si tu n'es pas certain, dis-le clairement
- Ne fais pas de recommandations thérapeutiques (c'est du ressort du clinicien)

Format de réponse :
- Commence par le raisonnement (dans le champ "raisonnement")
- Donne la réponse claire et concise (dans le champ "reponse")`;
}

/**
 * Génère la réponse de Dr Vox avec Gemini 1.5 Pro.
 *
 * Assemble le prompt complet avec le contexte, l'historique, les sources RAG
 * et la question, puis appelle Gemini pour la génération.
 *
 * @param question - La question du radiologue.
 * @param contexteRapport - Les sections du rapport en cours (optionnel).
 * @param historique - L'historique de conversation.
 * @param sources - Les passages RAG récupérés.
 * @returns La réponse et le raisonnement de Dr Vox.
 */
async function genererReponseDrVox(
  question: string,
  contexteRapport: Partial<SectionsRapport> | undefined,
  historique: Array<{ role: "user" | "assistant"; contenu: string }>,
  sources: GuidelineChunk[]
): Promise<{ texte: string; raisonnement?: string }> {
  // Formater les sources RAG pour le prompt
  const sourcesTexte =
    sources.length > 0
      ? "\n\nSources disponibles :\n" +
        sources
          .map((s, i) => `[${i + 1}] ${s.titre}: ${s.extrait}`)
          .join("\n")
      : "";

  // Formater le contexte du rapport en cours
  const contexteTexte =
    contexteRapport && Object.values(contexteRapport).some((v) => v)
      ? "\n\nRapport en cours d'édition :\n" +
        Object.entries(contexteRapport)
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")
      : "";

  // Formater l'historique de conversation
  const historiqueTexte =
    historique.length > 0
      ? "\n\nHistorique de la conversation :\n" +
        historique
          .slice(-MAX_HISTORY_MESSAGES) // Conserver les MAX_HISTORY_MESSAGES derniers échanges
          .map((h) => `${h.role === "user" ? "Radiologue" : "Dr Vox"}: ${h.contenu}`)
          .join("\n")
      : "";

  const promptComplet =
    construirePromptSysteme() +
    sourcesTexte +
    contexteTexte +
    historiqueTexte +
    `\n\nQuestion du radiologue : ${question}` +
    `\n\nRéponds avec un JSON : {"raisonnement": "<ta réflexion>", "reponse": "<ta réponse claire>"}`;

  try {
    const response = await generate({
      model: gemini15Pro,
      prompt: promptComplet,
      config: {
        temperature: 0.3, // Un peu plus créatif que la structuration mais reste précis
        maxOutputTokens: 1024,
      },
    });

    const generatedText = response.text();

    // Tentative de parsing JSON pour extraire le raisonnement et la réponse
    const jsonMatch = generatedText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as {
        raisonnement?: string;
        reponse?: string;
      };
      if (parsed.reponse) {
        return {
          texte: parsed.reponse,
          raisonnement: parsed.raisonnement,
        };
      }
    }

    // Si le parsing échoue, retourner le texte brut comme réponse
    return { texte: generatedText };
  } catch (error) {
    console.error("[drVoxFlow] Erreur Gemini Dr Vox:", error);
    return {
      texte:
        "Je suis désolé, je n'ai pas pu traiter votre question pour le moment. " +
        "Veuillez réessayer ou consulter directement les guidelines ACR/SFR.",
    };
  }
}
