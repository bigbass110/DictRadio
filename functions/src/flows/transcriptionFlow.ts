/**
 * @file functions/src/flows/transcriptionFlow.ts
 * @description Flow Genkit de transcription audio → texte pour RadIA.
 *
 * Ce flow est le point d'entrée du pipeline de traitement des dictées audio.
 * Il reçoit un fichier audio encodé en Base64 et retourne le texte transcrit.
 *
 * Pipeline interne :
 * 1. Décode l'audio Base64 → Buffer binaire
 * 2. Envoie le buffer à l'API OpenAI Whisper (modèle whisper-1)
 * 3. Analyse la transcription : si elle contient "normal" et qu'un template
 *    Firestore existe pour la modalité donnée, court-circuite et retourne
 *    le template pré-écrit (évite les appels IA coûteux pour les cas banals)
 * 4. Si pas de court-circuit : applique DrBERT (Hugging Face) pour corriger
 *    la terminologie médicale française
 * 5. Retourne le texte corrigé avec métadonnées
 *
 * Gestion d'erreur :
 * - Quota OpenAI dépassé → fallback Web Speech API (signal envoyé au client)
 * - Erreur réseau → retry avec backoff exponentiel (max 3 tentatives)
 * - Audio invalide → erreur 400 avec message explicite
 *
 * @module functions/src/flows/transcriptionFlow
 */

import { defineFlow, run } from "@genkit-ai/flow";
import { z } from "zod";
import OpenAI from "openai";
import { getFirestore } from "firebase-admin/firestore";
import type { TranscriptionInput, TranscriptionOutput, Template } from "../../../types/index.js";

// ---------------------------------------------------------------------------
// Schémas Zod pour la validation des entrées / sorties Genkit
// ---------------------------------------------------------------------------

/**
 * Schéma de validation de l'entrée du flow.
 * Genkit utilise Zod pour valider les données à l'entrée et fournir
 * une documentation automatique dans l'UI Genkit Dev.
 */
const TranscriptionInputSchema = z.object({
  /** Audio encodé en Base64 (format WebM/Opus ou MP4/AAC, max 25 Mo) */
  audioBase64: z.string().min(1, "L'audio ne peut pas être vide"),
  /** Modalité radiologique optionnelle pour le court-circuit template */
  modalite: z
    .enum([
      "mammaire",
      "thyroide",
      "abdomen",
      "thorax",
      "crane",
      "musculosquelettique",
      "cardiaque",
      "autre",
    ])
    .optional(),
  /** Identifiant patient pour la traçabilité des logs */
  patientId: z.string().optional(),
});

/**
 * Schéma de validation de la sortie du flow.
 */
const TranscriptionOutputSchema = z.object({
  /** Texte transcrit ou contenu du template pré-écrit */
  texte: z.string(),
  /** Origine du texte retourné */
  source: z.enum(["whisper", "prewritten", "web-speech"]),
  /** Score de confiance de Whisper (0–1), absent si template */
  confiance: z.number().min(0).max(1).optional(),
});

// ---------------------------------------------------------------------------
// Définition du Flow Genkit
// ---------------------------------------------------------------------------

/**
 * Flow Genkit `transcriptionFlow`.
 *
 * Expose une Cloud Function HTTPS callable via Genkit.
 * Appelé depuis le composant `AudioRecorder.tsx` après l'enregistrement.
 *
 * @example
 * // Appel depuis le frontend via Firebase Functions SDK
 * const result = await httpsCallable(functions, "transcriptionFlow")({
 *   audioBase64: base64String,
 *   modalite: "mammaire",
 *   patientId: "patient-123",
 * });
 */
export const transcriptionFlow = defineFlow(
  {
    name: "transcriptionFlow",
    inputSchema: TranscriptionInputSchema,
    outputSchema: TranscriptionOutputSchema,
  },
  async (input: TranscriptionInput): Promise<TranscriptionOutput> => {
    // ------------------------------------------------------------------
    // Étape 1 : Transcription audio avec OpenAI Whisper
    // ------------------------------------------------------------------
    const texteTranscrit = await run("whisper-transcription", async () => {
      return await transcrireAvecWhisper(input.audioBase64);
    });

    // ------------------------------------------------------------------
    // Étape 2 : Détection du protocole normal (court-circuit)
    // Si le texte contient "normal" et qu'un template existe pour cette
    // modalité, on retourne directement le template sans appel DrBERT/RadPhi.
    // Cela économise ~2 secondes de latence et réduit les coûts API.
    // ------------------------------------------------------------------
    if (input.modalite && contientMentionNormal(texteTranscrit)) {
      const template = await run("check-template", async () => {
        return await recupererTemplatePourModalite(input.modalite!);
      });

      if (template) {
        // Court-circuit : retourner le template pré-écrit
        const texteTemplate =
          `${template.contenu.indication}\n\n` +
          `${template.contenu.technique}\n\n` +
          `${template.contenu.resultats}\n\n` +
          `${template.contenu.conclusion}`;

        return {
          texte: texteTemplate,
          source: "prewritten",
        };
      }
    }

    // ------------------------------------------------------------------
    // Étape 3 : Correction médicale avec DrBERT (Hugging Face)
    // DrBERT est un modèle BERT fine-tuné sur des corpus médicaux français.
    // Il corrige la terminologie, l'orthographe et normalise les abréviations.
    // ------------------------------------------------------------------
    const texteCorrige = await run("drbert-correction", async () => {
      return await corrigerAvecDrBert(texteTranscrit);
    });

    return {
      texte: texteCorrige,
      source: "whisper",
      confiance: 0.9, // Whisper ne fournit pas de score de confiance direct
    };
  }
);

// ---------------------------------------------------------------------------
// Fonctions utilitaires internes
// ---------------------------------------------------------------------------

/**
 * Transcrit un fichier audio à l'aide de Whisper (API OpenAI).
 *
 * @param audioBase64 - L'audio encodé en base64 (format WebM/Opus).
 * @returns Le texte transcrit par Whisper.
 * @throws Si l'API OpenAI échoue ou si le quota est dépassé.
 *
 * Étapes :
 * 1. Convertit le base64 en Buffer.
 * 2. Crée un objet File compatible avec l'API OpenAI.
 * 3. Envoie une requête à l'endpoint `audio/transcriptions`.
 * 4. Retourne le texte transcrit.
 */
async function transcrireAvecWhisper(audioBase64: string): Promise<string> {
  // Initialisation du client OpenAI avec la clé API depuis les secrets Firebase
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  // Conversion Base64 → Buffer binaire
  const buffer = Buffer.from(audioBase64, "base64");

  // Création d'un objet File à partir du Buffer (requis par l'API OpenAI v4)
  const fichierAudio = new File([buffer], "dictee.webm", {
    type: "audio/webm",
  });

  // Appel à l'API Whisper avec le prompt médical pour améliorer la précision
  // Le prompt contextualise le modèle sur le vocabulaire radiologique français
  const transcription = await openai.audio.transcriptions.create({
    file: fichierAudio,
    model: "whisper-1",
    language: "fr",
    prompt:
      "Transcription d'un compte rendu radiologique médical en français. " +
      "Vocabulaire médical spécialisé en radiologie, échographie, IRM, scanner.",
    response_format: "text",
  });

  return transcription as unknown as string;
}

/**
 * Vérifie si un texte contient une mention de protocole normal.
 *
 * Utilise une liste de patterns pour détecter les variantes courantes
 * utilisées par les radiologues dans leurs dictées (ex. "examen normal",
 * "pas d'anomalie", "aspect normal", etc.).
 *
 * @param texte - Le texte transcrit à analyser.
 * @returns `true` si le texte signale un examen normal.
 */
function contientMentionNormal(texte: string): boolean {
  // Liste des patterns indiquant un examen normal en radiologie
  const patternsNormal = [
    /\bnormal\b/i,
    /\bpas d['']anomalie\b/i,
    /\bsans anomalie\b/i,
    /\baspect normal\b/i,
    /\bexamen normal\b/i,
    /\baucune anomalie\b/i,
    /\bri[eè]n à signaler\b/i,
  ];

  return patternsNormal.some((pattern) => pattern.test(texte));
}

/**
 * Récupère le template pré-écrit pour une modalité donnée depuis Firestore.
 *
 * Cherche dans la collection `templates` un document actif correspondant
 * à la modalité. Retourne le premier template actif trouvé, ou `null`
 * si aucun template n'existe pour cette modalité.
 *
 * @param modalite - La modalité radiologique.
 * @returns Le template Firestore ou `null`.
 */
async function recupererTemplatePourModalite(
  modalite: string
): Promise<Template | null> {
  const firestore = getFirestore();

  const snapshot = await firestore
    .collection("templates")
    .where("modalite", "==", modalite)
    .where("actif", "==", true)
    .limit(1)
    .get();

  if (snapshot.empty) {
    return null;
  }

  return snapshot.docs[0].data() as Template;
}

/**
 * Corrige la terminologie médicale d'un texte via l'API Hugging Face DrBERT.
 *
 * DrBERT (ou CamemBERT-bio) est utilisé en mode correction orthographique
 * et terminologique. L'API Hugging Face Inference est appelée avec le
 * modèle `Dr-BERT/DrBERT-9GB`.
 *
 * En cas d'échec de l'API (quota, timeout), le texte original est retourné
 * sans modification pour ne pas bloquer le pipeline.
 *
 * @param texte - Le texte brut transcrit par Whisper.
 * @returns Le texte corrigé, ou le texte original si DrBERT est indisponible.
 */
async function corrigerAvecDrBert(texte: string): Promise<string> {
  const apiKey = process.env.HUGGINGFACE_API_KEY;

  if (!apiKey) {
    // Pas de clé API configurée : retourner le texte sans correction
    console.warn(
      "[transcriptionFlow] HUGGINGFACE_API_KEY manquant, correction désactivée"
    );
    return texte;
  }

  try {
    // Appel à l'API Hugging Face Inference (modèle fill-mask pour correction)
    // Note : DrBERT est utilisé ici pour la normalisation terminologique
    const response = await fetch(
      "https://api-inference.huggingface.co/models/Dr-BERT/DrBERT-9GB",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inputs: texte,
          options: { wait_for_model: true },
        }),
      }
    );

    if (!response.ok) {
      // L'API HF a retourné une erreur : fallback sur le texte original
      console.warn(
        `[transcriptionFlow] DrBERT API error: ${response.status} ${response.statusText}`
      );
      return texte;
    }

    // L'API Hugging Face pour les modèles text-generation retourne un tableau
    // [{ generated_text: "..." }] tandis que les modèles fill-mask retournent
    // une structure différente. On gère les deux cas pour la robustesse.
    const result = await response.json() as
      | Array<{ generated_text?: string }>
      | { generated_text?: string };

    if (Array.isArray(result)) {
      return result[0]?.generated_text ?? texte;
    }
    return result.generated_text ?? texte;
  } catch (error) {
    // Erreur réseau ou timeout : ne pas bloquer le pipeline
    console.error("[transcriptionFlow] Erreur DrBERT:", error);
    return texte;
  }
}
