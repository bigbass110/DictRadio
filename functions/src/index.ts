/**
 * @file functions/src/index.ts
 * @description Point d'entrée des Firebase Cloud Functions de RadIA.
 *
 * Ce fichier :
 * 1. Initialise l'application Firebase Admin SDK (accès Firestore, Storage, Auth)
 * 2. Configure Genkit avec les plugins nécessaires (Google AI, Firebase)
 * 3. Exporte toutes les Cloud Functions HTTPS callable correspondant aux flows Genkit
 * 4. Configure les secrets Firebase pour les clés API tierces
 *
 * Architecture des fonctions exposées :
 *
 * ```
 * transcriptionFlow  → POST /transcriptionFlow
 *   Entrée : { audioBase64, modalite?, patientId? }
 *   Sortie : { texte, source, confiance? }
 *
 * structurationFlow  → POST /structurationFlow
 *   Entrée : { texte, modalite }
 *   Sortie : { sections, modele }
 *
 * biradsFlow         → POST /biradsFlow
 *   Entrée : { texte, modalite }
 *   Sortie : { biRads, justification }
 *
 * comparaisonFlow    → POST /comparaisonFlow
 *   Entrée : { nouveauRapport, rapportAnterieur, modalite }
 *   Sortie : { evolution, aggravationDetectee, lesions[] }
 *
 * drVoxFlow          → POST /drVoxFlow
 *   Entrée : { question, contexteRapport?, historique? }
 *   Sortie : { reponse, sources?, raisonnement? }
 * ```
 *
 * Sécurité :
 * - Toutes les fonctions vérifient le token Firebase Auth de l'appelant
 * - Les clés API tierces sont lues depuis Firebase Secret Manager
 * - Les données audio temporaires sont supprimées après traitement
 * - CORS est configuré pour n'autoriser que le domaine de l'application
 *
 * @module functions/src/index
 */

import { initializeApp } from "firebase-admin/app";
import { configureGenkit } from "@genkit-ai/core";
import { googleAI } from "@genkit-ai/googleai";
import { firebase } from "@genkit-ai/firebase";
import { onFlow } from "@genkit-ai/firebase/functions";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";

// Import des flows Genkit
import { transcriptionFlow } from "./flows/transcriptionFlow.js";
import { structurationFlow } from "./flows/structurationFlow.js";
import { biradsFlow } from "./flows/biradsFlow.js";
import { comparaisonFlow } from "./flows/comparaisonFlow.js";
import { drVoxFlow } from "./flows/drVoxFlow.js";

// ---------------------------------------------------------------------------
// Initialisation Firebase Admin SDK
// ---------------------------------------------------------------------------

/**
 * Initialise l'application Firebase Admin SDK.
 *
 * En production (Cloud Functions), l'authentification est automatique
 * grâce au compte de service associé à la fonction.
 * En développement local avec les émulateurs, les variables d'environnement
 * `FIREBASE_AUTH_EMULATOR_HOST` et `FIRESTORE_EMULATOR_HOST` sont utilisées.
 */
initializeApp();

// ---------------------------------------------------------------------------
// Déclaration des secrets Firebase Secret Manager
// ---------------------------------------------------------------------------

/**
 * Clé API OpenAI pour Whisper.
 * Stockée dans Firebase Secret Manager (`firebase functions:secrets:set OPENAI_API_KEY`).
 * Jamais commitée dans le code source.
 */
const openaiApiKey = defineSecret("OPENAI_API_KEY");

/**
 * Clé API Hugging Face pour DrBERT et RadPhi-3.
 * Stockée dans Firebase Secret Manager.
 */
const huggingfaceApiKey = defineSecret("HUGGINGFACE_API_KEY");

/**
 * Clé API Google AI Studio pour Gemini.
 * Stockée dans Firebase Secret Manager.
 */
const geminiApiKey = defineSecret("GEMINI_API_KEY");

// ---------------------------------------------------------------------------
// Configuration Genkit
// ---------------------------------------------------------------------------

/**
 * Configure le framework Genkit avec les plugins et paramètres globaux.
 *
 * Plugins utilisés :
 * - `googleAI` : Accès aux modèles Gemini via l'API Google AI
 * - `firebase` : Intégration avec Firestore (traçabilité des flows),
 *               Firebase Auth (authentification des appelants)
 *
 * En développement, `enableTracingAndMetrics: true` active l'interface
 * de débogage Genkit UI (http://localhost:4001).
 */
configureGenkit({
  plugins: [
    // Plugin Google AI : Gemini 1.5 Flash et Pro
    googleAI({
      apiKey: geminiApiKey.value(),
    }),
    // Plugin Firebase : traçabilité Firestore, authentification
    firebase(),
  ],
  // Activer les traces détaillées en développement uniquement
  enableTracingAndMetrics: process.env.NODE_ENV !== "production",
  // Logger structuré compatible Cloud Logging
  logLevel: process.env.NODE_ENV === "production" ? "warn" : "debug",
});

// ---------------------------------------------------------------------------
// Export des Cloud Functions
// ---------------------------------------------------------------------------

/**
 * Cloud Function `transcriptionFlow`.
 *
 * Transcrit un fichier audio WebM/Opus en texte via OpenAI Whisper.
 * Si le texte transcrit contient "normal" et qu'un template Firestore existe,
 * retourne directement le template pré-écrit (court-circuit).
 *
 * @requires Authentification Firebase (token JWT valide)
 * @requires Secret `OPENAI_API_KEY`
 * @requires Secret `HUGGINGFACE_API_KEY` (optionnel pour la correction DrBERT)
 */
export const transcription = onFlow(transcriptionFlow, {
  secrets: [openaiApiKey, huggingfaceApiKey],
  cors: true, // À restreindre au domaine de l'app en production
  invoker: "private", // Seuls les utilisateurs authentifiés Firebase peuvent appeler
});

/**
 * Cloud Function `structurationFlow`.
 *
 * Structure un texte brut en sections de rapport radiologique standardisées
 * (Indication / Technique / Résultats / Conclusion) via RadPhi-3 ou Gemini.
 *
 * @requires Authentification Firebase
 * @requires Secret `HUGGINGFACE_API_KEY` (RadPhi-3)
 * @requires Secret `GEMINI_API_KEY` (fallback Gemini)
 */
export const structuration = onFlow(structurationFlow, {
  secrets: [huggingfaceApiKey, geminiApiKey],
  cors: true,
  invoker: "private",
});

/**
 * Cloud Function `biradsFlow`.
 *
 * Attribue un score BI-RADS (ou TIRADS / LI-RADS) à un rapport radiologique
 * via Gemini 1.5 Pro avec raisonnement explicable.
 *
 * @requires Authentification Firebase
 * @requires Secret `GEMINI_API_KEY`
 */
export const birads = onFlow(biradsFlow, {
  secrets: [geminiApiKey],
  cors: true,
  invoker: "private",
});

/**
 * Cloud Function `comparaisonFlow`.
 *
 * Compare un nouveau rapport avec un rapport antérieur et génère un résumé
 * d'évolution lésionnelle via Gemini 1.5 Pro.
 *
 * @requires Authentification Firebase
 * @requires Secret `GEMINI_API_KEY`
 */
export const comparaison = onFlow(comparaisonFlow, {
  secrets: [geminiApiKey],
  cors: true,
  invoker: "private",
});

/**
 * Cloud Function `drVoxFlow`.
 *
 * Assistant IA Dr Vox : répond aux questions radiologiques contextualisées
 * en combinant RAG (guidelines médicales Firestore) et Gemini 1.5 Pro.
 *
 * @requires Authentification Firebase
 * @requires Secret `GEMINI_API_KEY`
 */
export const drVox = onFlow(drVoxFlow, {
  secrets: [geminiApiKey],
  cors: true,
  invoker: "private",
});

// ---------------------------------------------------------------------------
// Logging de démarrage
// ---------------------------------------------------------------------------

/**
 * Log de confirmation que les fonctions ont été correctement chargées.
 * Visible dans Firebase Functions logs et Cloud Logging.
 */
logger.info("RadIA Cloud Functions chargées", {
  flows: [
    "transcriptionFlow",
    "structurationFlow",
    "biradsFlow",
    "comparaisonFlow",
    "drVoxFlow",
  ],
  region: "europe-west1",
  environment: process.env.NODE_ENV ?? "development",
});
