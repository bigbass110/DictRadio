/**
 * @file lib/firebase.ts
 * @description Initialisation et export du SDK Firebase côté client (navigateur).
 *
 * Ce module est importé par tous les composants React et pages Next.js
 * qui ont besoin d'interagir avec les services Firebase :
 * - Firestore (lecture/écriture des rapports et templates)
 * - Firebase Authentication (connexion des radiologues)
 * - Firebase Storage (upload temporaire des fichiers audio)
 * - Firebase Functions (appel des flows Genkit via HTTPS callable)
 *
 * La configuration est lue depuis les variables d'environnement
 * (`NEXT_PUBLIC_FIREBASE_*`) pour ne pas exposer de secrets dans le code source.
 *
 * En développement local, le module se connecte automatiquement aux émulateurs
 * Firebase si `NEXT_PUBLIC_USE_EMULATOR=true` est défini.
 *
 * @module lib/firebase
 */

import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  getFirestore,
  connectFirestoreEmulator,
  type Firestore,
} from "firebase/firestore";
import {
  getAuth,
  connectAuthEmulator,
  type Auth,
} from "firebase/auth";
import {
  getStorage,
  connectStorageEmulator,
  type FirebaseStorage,
} from "firebase/storage";
import {
  getFunctions,
  connectFunctionsEmulator,
  type Functions,
} from "firebase/functions";

// ---------------------------------------------------------------------------
// Configuration Firebase
// ---------------------------------------------------------------------------

/**
 * Objet de configuration Firebase lu depuis les variables d'environnement.
 *
 * Toutes les variables sont préfixées `NEXT_PUBLIC_` car elles doivent être
 * accessibles côté navigateur (Next.js expose uniquement ces variables
 * au bundle client).
 *
 * ⚠️ Ces valeurs ne sont PAS des secrets — elles sont publiques et sécurisées
 * par les règles Firestore et Firebase Auth. Ne jamais mettre les clés API
 * des services tiers (OpenAI, HuggingFace) dans ces variables.
 */
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// ---------------------------------------------------------------------------
// Initialisation de l'application Firebase (singleton)
// ---------------------------------------------------------------------------

/**
 * Instance de l'application Firebase.
 *
 * `getApps()` retourne les applications déjà initialisées. Cette vérification
 * est nécessaire avec Next.js car le module peut être importé plusieurs fois
 * (côté serveur lors du SSR et côté client lors de l'hydratation).
 * Sans cette garde, Firebase lèverait une erreur "app already exists".
 */
const app: FirebaseApp =
  getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

// ---------------------------------------------------------------------------
// Instances des services Firebase
// ---------------------------------------------------------------------------

/**
 * Instance Firestore pour la lecture et l'écriture des documents.
 * Utilisée pour : rapports, templates, profils utilisateurs.
 */
const db: Firestore = getFirestore(app);

/**
 * Instance Firebase Authentication pour la gestion des sessions utilisateurs.
 * RadIA utilise l'authentification par email/mot de passe et Google SSO.
 */
const auth: Auth = getAuth(app);

/**
 * Instance Firebase Storage pour l'upload temporaire des fichiers audio.
 * Les fichiers audio sont supprimés après transcription (rétention 24h max).
 */
const storage: FirebaseStorage = getStorage(app);

/**
 * Instance Firebase Functions pour l'appel des Cloud Functions Genkit.
 * La région `europe-west1` (Belgique) est utilisée pour la conformité RGPD.
 */
const functions: Functions = getFunctions(app, "europe-west1");

// ---------------------------------------------------------------------------
// Connexion aux émulateurs en développement local
// ---------------------------------------------------------------------------

/**
 * En développement local, connecte tous les services Firebase aux émulateurs
 * locaux plutôt qu'aux services de production.
 *
 * Avantages des émulateurs :
 * - Pas de coût d'utilisation
 * - Données isolées (ne modifie pas la production)
 * - Rechargement à chaud avec `firebase emulators:start`
 *
 * Activé par la variable d'environnement `NEXT_PUBLIC_USE_EMULATOR=true`.
 * Cette logique n'est exécutée que côté client (typeof window !== "undefined")
 * pour éviter les conflits avec le rendu côté serveur de Next.js.
 */
if (
  process.env.NEXT_PUBLIC_USE_EMULATOR === "true" &&
  typeof window !== "undefined"
) {
  // Ports par défaut des émulateurs Firebase
  connectFirestoreEmulator(db, "localhost", 8080);
  connectAuthEmulator(auth, "http://localhost:9099", { disableWarnings: true });
  connectStorageEmulator(storage, "localhost", 9199);
  connectFunctionsEmulator(functions, "localhost", 5001);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { app, db, auth, storage, functions };
