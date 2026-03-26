/**
 * @file types/index.ts
 * @description Définitions TypeScript partagées entre le frontend et les Cloud Functions.
 *
 * Ce fichier centralise toutes les interfaces et types du domaine médical de RadIA :
 * rapports radiologiques, patients, templates, résultats BI-RADS, etc.
 * L'utilisation de types stricts évite les erreurs de runtime et documente
 * implicitement la structure des données Firestore.
 */

// ---------------------------------------------------------------------------
// Domaine : Rapport radiologique
// ---------------------------------------------------------------------------

/**
 * Modalités d'imagerie médicale supportées par RadIA.
 * Utilisée pour sélectionner le template approprié et déclencher
 * les flows BI-RADS spécifiques à la modalité.
 */
export type Modalite =
  | "mammaire"      // Mammographie / échographie mammaire
  | "thyroide"      // Échographie thyroïdienne
  | "abdomen"       // Échographie ou scanner abdominal
  | "thorax"        // Scanner thoracique
  | "crane"         // IRM ou scanner cérébral
  | "musculosquelettique" // IRM ou radiographie ostéo-articulaire
  | "cardiaque"     // Échographie cardiaque
  | "autre";        // Modalité non répertoriée

/**
 * Sections standardisées d'un compte rendu radiologique.
 * Correspond à la structure RSNA/SFR recommandée pour les rapports structurés.
 */
export interface SectionsRapport {
  /** Raison de l'examen, contexte clinique fourni par le prescripteur */
  indication: string;
  /** Protocole technique utilisé (machine, paramètres, produit de contraste) */
  technique: string;
  /** Observations détaillées, organe par organe */
  resultats: string;
  /** Synthèse diagnostique et recommandations */
  conclusion: string;
}

/**
 * Score BI-RADS (Breast Imaging-Reporting and Data System) ou équivalent
 * pour d'autres organes (TIRADS pour la thyroïde, LI-RADS pour le foie, etc.).
 */
export interface ScoreBiRads {
  /** Score numérique (0–6 pour ACR BI-RADS) */
  score: number;
  /** Catégorie textuelle (ex. "ACR 3 – Probablement bénin") */
  categorie: string;
  /** Recommandation clinique générée par le flow biradsFlow */
  recommandation: string;
  /** Système de classification utilisé */
  systeme: "BI-RADS" | "TIRADS" | "LI-RADS" | "RENAL" | "autre";
}

/**
 * Représente un rapport radiologique complet archivé dans Firestore.
 * Collection Firestore : `rapports/{rapportId}`
 */
export interface Rapport {
  /** Identifiant unique du rapport (généré par Firestore) */
  id?: string;
  /** Identifiant du patient (pseudonymisé pour respecter le RGPD) */
  patientId: string;
  /** Identifiant du radiologue auteur du rapport */
  radiologueId: string;
  /** Modalité d'imagerie concernée */
  modalite: Modalite;
  /** Date et heure de l'examen */
  dateExamen: Date | string;
  /** Date et heure de création du rapport dans le système */
  dateCreation: Date | string;
  /** Sections structurées du rapport */
  sections: SectionsRapport;
  /** Transcription audio brute avant structuration (conservée à des fins d'audit) */
  transcriptionBrute?: string;
  /** Source de la transcription */
  sourceTranscription: "whisper" | "prewritten" | "web-speech" | "manuel";
  /** Score BI-RADS si applicable */
  biRads?: ScoreBiRads;
  /** Identifiant du rapport antérieur utilisé pour comparaison */
  rapportAnterieurId?: string;
  /** Résumé de l'évolution par rapport au rapport antérieur */
  evolution?: string;
  /** Statut du rapport dans son cycle de vie */
  statut: "brouillon" | "en_revision" | "valide" | "archive";
  /** Version du schéma de données (pour migrations futures) */
  schemaVersion: number;
}

// ---------------------------------------------------------------------------
// Domaine : Template pré-écrit
// ---------------------------------------------------------------------------

/**
 * Template de rapport pré-écrit pour les protocoles normaux.
 * Stocké dans la collection Firestore `templates/{templateId}`.
 * Utilisé par le court-circuit dans `transcriptionFlow` lorsque
 * le texte transcrit contient le mot « normal ».
 */
export interface Template {
  /** Identifiant unique du template */
  id?: string;
  /** Modalité à laquelle ce template s'applique */
  modalite: Modalite;
  /** Titre descriptif du template (ex. "Mammographie normale de dépistage") */
  titre: string;
  /** Contenu texte du template, peut contenir des marqueurs {{variable}} */
  contenu: SectionsRapport;
  /** L'auteur du template (radiologue référent) */
  auteurId: string;
  /** Date de dernière mise à jour */
  dateMiseAJour: Date | string;
  /** Indique si ce template est actif et utilisable */
  actif: boolean;
}

// ---------------------------------------------------------------------------
// Domaine : Utilisateur / Radiologue
// ---------------------------------------------------------------------------

/**
 * Profil d'un utilisateur de RadIA (radiologue ou manipulateur).
 * Collection Firestore : `utilisateurs/{uid}`
 * Le champ `uid` correspond à l'UID Firebase Authentication.
 */
export interface Utilisateur {
  /** UID Firebase Authentication */
  uid: string;
  /** Nom complet */
  nomComplet: string;
  /** Adresse email professionnelle */
  email: string;
  /** Rôle dans le système */
  role: "radiologue" | "manipulateur" | "administrateur";
  /** Spécialité radiologique principale */
  specialite?: string;
  /** Numéro RPPS (Répertoire Partagé des Professionnels de Santé) */
  rpps?: string;
  /** Date de création du compte */
  dateCreation: Date | string;
  /** Préférences d'interface */
  preferences?: {
    /** Langue de l'interface */
    langue: "fr" | "en";
    /** Thème visuel */
    theme: "clair" | "sombre";
    /** Modalités affichées par défaut dans le tableau de bord */
    modalitesDefaut: Modalite[];
  };
}

// ---------------------------------------------------------------------------
// Inputs / Outputs des Flows Genkit
// ---------------------------------------------------------------------------

/**
 * Paramètres d'entrée pour le flow de transcription audio.
 */
export interface TranscriptionInput {
  /** Audio encodé en Base64 (format WebM/Opus ou MP4/AAC) */
  audioBase64: string;
  /** Modalité radiologique pour sélectionner le template de court-circuit */
  modalite?: Modalite;
  /** Identifiant du patient pour la traçabilité */
  patientId?: string;
}

/**
 * Résultat retourné par le flow de transcription.
 */
export interface TranscriptionOutput {
  /** Texte transcrit ou texte du template pré-écrit */
  texte: string;
  /** Origine du texte */
  source: "whisper" | "prewritten" | "web-speech";
  /** Confiance estimée de la transcription (0–1), null si template */
  confiance?: number;
}

/**
 * Paramètres d'entrée pour le flow de structuration sémantique.
 */
export interface StructurationInput {
  /** Texte brut à structurer (issu de la transcription) */
  texte: string;
  /** Modalité pour adapter le prompt de structuration */
  modalite: Modalite;
}

/**
 * Résultat retourné par le flow de structuration.
 */
export interface StructurationOutput {
  /** Sections structurées du rapport */
  sections: SectionsRapport;
  /** Modèle IA utilisé pour la structuration */
  modele: "radphi3" | "gemini" | "fallback";
}

/**
 * Paramètres d'entrée pour le flow de classification BI-RADS.
 */
export interface BiradsInput {
  /** Texte du rapport à analyser */
  texte: string;
  /** Modalité (doit être "mammaire" ou "thyroide" pour BI-RADS/TIRADS) */
  modalite: Modalite;
}

/**
 * Résultat retourné par le flow BI-RADS.
 */
export interface BiradsOutput {
  /** Score calculé, null si non applicable */
  biRads: ScoreBiRads | null;
  /** Justification clinique du score */
  justification: string;
}

/**
 * Paramètres d'entrée pour le flow de comparaison avec rapport antérieur.
 */
export interface ComparaisonInput {
  /** Sections du nouveau rapport */
  nouveauRapport: SectionsRapport;
  /** Sections du rapport antérieur */
  rapportAnterieur: SectionsRapport;
  /** Modalité pour contextualiser la comparaison */
  modalite: Modalite;
}

/**
 * Résultat retourné par le flow de comparaison.
 */
export interface ComparaisonOutput {
  /** Résumé textuel des évolutions entre les deux rapports */
  evolution: string;
  /** Indique si une aggravation significative a été détectée */
  aggravationDetectee: boolean;
  /** Liste des lésions avec leur statut d'évolution */
  lesions: Array<{
    description: string;
    evolution: "stable" | "augmentation" | "diminution" | "nouvelle" | "disparue";
  }>;
}

/**
 * Paramètres d'entrée pour l'assistant Dr Vox.
 */
export interface DrVoxInput {
  /** Question posée par le radiologue */
  question: string;
  /** Contexte du rapport en cours (pour la réponse contextualisée) */
  contexteRapport?: Partial<SectionsRapport>;
  /** Historique de la conversation (pour le mode multi-tours) */
  historique?: Array<{ role: "user" | "assistant"; contenu: string }>;
}

/**
 * Réponse de l'assistant Dr Vox.
 */
export interface DrVoxOutput {
  /** Réponse de l'assistant */
  reponse: string;
  /** Sources documentaires utilisées (RAG) */
  sources?: Array<{
    titre: string;
    extrait: string;
    url?: string;
  }>;
  /** Raisonnement intermédiaire (chain-of-thought, si Gemini le fournit) */
  raisonnement?: string;
}
