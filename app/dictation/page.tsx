/**
 * @file app/dictation/page.tsx
 * @description Page principale de dictée radiologique de RadIA.
 *
 * Cette page orchestre le flux complet de création d'un rapport :
 * 1. Sélection de la modalité et du patient
 * 2. Enregistrement audio via `<AudioRecorder>`
 * 3. Appel du flow `structurationFlow` après transcription
 * 4. Appel optionnel des flows `biradsFlow` et `comparaisonFlow`
 * 5. Édition du rapport structuré via `<Editor>`
 * 6. Chat contextuel avec Dr Vox via `<DrVoxChat>`
 *
 * Architecture de la page :
 * ```
 * ┌─────────────────────────────┬────────────────┐
 * │         ZONE PRINCIPALE     │   DR VOX CHAT  │
 * │                             │                │
 * │  [Sélecteur modalité/patient]│  [BulleChat]  │
 * │  [AudioRecorder]            │  [BulleChat]   │
 * │  [Editor]                   │  [InputChat]   │
 * └─────────────────────────────┴────────────────┘
 * ```
 *
 * Cette page est un Client Component car elle gère un état local complexe
 * et des appels aux Cloud Functions Firebase.
 *
 * @module app/dictation/page
 */

"use client";

import React, { useState, useCallback, useEffect, type FC } from "react";
import { httpsCallable } from "firebase/functions";
import { onAuthStateChanged, type User } from "firebase/auth";
import { auth, functions } from "@/lib/firebase";
import AudioRecorder from "@/components/AudioRecorder";
import Editor from "@/components/Editor";
import DrVoxChat from "@/components/DrVoxChat";
import type {
  Modalite,
  SectionsRapport,
  ScoreBiRads,
  StructurationInput,
  StructurationOutput,
  BiradsInput,
  BiradsOutput,
  TranscriptionOutput,
} from "@/types";

// ---------------------------------------------------------------------------
// Types locaux
// ---------------------------------------------------------------------------

/**
 * États possibles du pipeline de traitement IA.
 */
type EtatPipeline =
  | "idle"              // En attente de dictée
  | "transcription"     // Transcription Whisper en cours
  | "structuration"     // Structuration RadPhi-3/Gemini en cours
  | "birads"            // Classification BI-RADS en cours
  | "pret";             // Pipeline terminé, rapport disponible

// ---------------------------------------------------------------------------
// Composant de page
// ---------------------------------------------------------------------------

/**
 * Page de dictée radiologique.
 *
 * Gère l'état global du pipeline de traitement et coordonne les composants
 * `AudioRecorder`, `Editor` et `DrVoxChat`.
 */
const PageDictee: FC = () => {
  // -------------------------------------------------------------------------
  // État local
  // -------------------------------------------------------------------------

  /** Modalité sélectionnée par le radiologue */
  const [modalite, setModalite] = useState<Modalite>("abdomen");

  /** Identifiant patient saisi (pseudonymisé) */
  const [patientId, setPatientId] = useState<string>("");

  /** État d'avancement du pipeline IA */
  const [etatPipeline, setEtatPipeline] = useState<EtatPipeline>("idle");

  /** Étape actuelle du pipeline (pour l'affichage de la progression) */
  const [etapeEnCours, setEtapeEnCours] = useState<string>("");

  /** Sections du rapport structuré (résultat du pipeline) */
  const [sectionsRapport, setSectionsRapport] =
    useState<Partial<SectionsRapport> | undefined>(undefined);

  /** Score BI-RADS calculé (si applicable) */
  const [biRads, setBiRads] = useState<ScoreBiRads | null>(null);

  /** Identifiant du rapport Firestore (après première sauvegarde) */
  const [rapportId, setRapportId] = useState<string | null>(null);

  /**
   * Utilisateur Firebase Auth actuellement connecté.
   * Son UID est utilisé comme `radiologueId` dans Firestore.
   * null = non encore chargé, undefined = non connecté.
   */
  const [utilisateurCourant, setUtilisateurCourant] = useState<User | null | undefined>(
    undefined
  );

  /** Afficher ou masquer le panneau Dr Vox */
  const [drVoxVisible, setDrVoxVisible] = useState<boolean>(true);

  /** Message d'erreur pipeline */
  const [erreurPipeline, setErreurPipeline] = useState<string>("");

  // -------------------------------------------------------------------------
  // Chargement de l'utilisateur Firebase Auth
  // -------------------------------------------------------------------------

  /**
   * Souscrit aux changements d'état d'authentification Firebase.
   * L'UID de l'utilisateur connecté est utilisé comme `radiologueId`
   * dans Firestore pour respecter les règles de sécurité.
   */
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUtilisateurCourant(user);
    });
    return unsubscribe; // Nettoyage : désinscription à la destruction
  }, []);

  // -------------------------------------------------------------------------
  // Gestionnaires du pipeline
  // -------------------------------------------------------------------------

  /**
   * Déclenché quand `AudioRecorder` a obtenu la transcription audio.
   *
   * Lance le pipeline en cascade :
   * 1. structurationFlow → sections structurées
   * 2. biradsFlow → score BI-RADS (si modalite mammaire/thyroide/abdomen)
   *
   * @param texteTranscrit - Le texte transcrit par Whisper (ou template).
   * @param sourceTranscription - L'origine du texte.
   */
  const handleTranscription = useCallback(
    async (texteTranscrit: string, sourceTranscription: TranscriptionOutput["source"]) => {
      setErreurPipeline("");

      // ------------------------------------------------------------------
      // Étape 1 : Structuration du texte
      // ------------------------------------------------------------------
      setEtatPipeline("structuration");
      setEtapeEnCours("Structuration du rapport (RadPhi-3)…");

      let sections: SectionsRapport | undefined;

      try {
        const structurationFn = httpsCallable<StructurationInput, StructurationOutput>(
          functions,
          "structuration"
        );

        const resultatStructuration = await structurationFn({
          texte: texteTranscrit,
          modalite,
        });

        sections = resultatStructuration.data.sections;
        setSectionsRapport(sections);
      } catch (err) {
        console.error("[PageDictee] Erreur structuration:", err);
        // En cas d'erreur de structuration, mettre le texte brut dans "resultats"
        sections = {
          indication: "",
          technique: "",
          resultats: texteTranscrit,
          conclusion: "",
        };
        setSectionsRapport(sections);
      }

      // ------------------------------------------------------------------
      // Étape 2 : Classification BI-RADS (si modalité applicable)
      // ------------------------------------------------------------------
      const modalitesAvecBiRads: Modalite[] = ["mammaire", "thyroide", "abdomen"];

      if (modalitesAvecBiRads.includes(modalite) && sections) {
        setEtatPipeline("birads");
        setEtapeEnCours("Classification BI-RADS (Gemini)…");

        try {
          const biradfFn = httpsCallable<BiradsInput, BiradsOutput>(
            functions,
            "birads"
          );

          const texteComplet =
            `${sections.indication} ${sections.resultats} ${sections.conclusion}`.trim();

          const resultatBiRads = await biradfFn({
            texte: texteComplet,
            modalite,
          });

          setBiRads(resultatBiRads.data.biRads);
        } catch (err) {
          console.warn("[PageDictee] Classification BI-RADS échouée:", err);
          // Ne pas bloquer le pipeline si BI-RADS échoue
        }
      }

      // Pipeline terminé
      setEtatPipeline("pret");
      setEtapeEnCours("");
    },
    [modalite]
  );

  /**
   * Gestionnaire d'erreur de l'AudioRecorder.
   *
   * @param message - Le message d'erreur à afficher.
   */
  const handleErreurRecordeur = useCallback((message: string) => {
    setErreurPipeline(message);
    setEtatPipeline("idle");
  }, []);

  /**
   * Réinitialise le formulaire pour une nouvelle dictée.
   */
  const reinitialiser = useCallback(() => {
    setEtatPipeline("idle");
    setSectionsRapport(undefined);
    setBiRads(null);
    setRapportId(null);
    setErreurPipeline("");
    setEtapeEnCours("");
  }, []);

  // -------------------------------------------------------------------------
  // Rendu
  // -------------------------------------------------------------------------

  return (
    <div className="flex gap-6 h-[calc(100vh-theme(spacing.32))]">
      {/* ------------------------------------------------------------------ */}
      {/* Zone principale */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex-1 overflow-y-auto space-y-6">
        {/* Sélecteur de modalité et patient */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
          <h1 className="text-xl font-semibold text-gray-900 mb-4">
            Nouvelle dictée radiologique
          </h1>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Sélecteur de modalité */}
            <div>
              <label
                htmlFor="modalite"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Modalité *
              </label>
              <select
                id="modalite"
                value={modalite}
                onChange={(e) => setModalite(e.target.value as Modalite)}
                disabled={etatPipeline !== "idle"}
                className="w-full p-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:cursor-not-allowed"
              >
                <option value="mammaire">Mammographie / Échographie mammaire</option>
                <option value="thyroide">Échographie thyroïdienne</option>
                <option value="abdomen">Échographie / Scanner abdominal</option>
                <option value="thorax">Scanner thoracique</option>
                <option value="crane">IRM / Scanner cérébral</option>
                <option value="musculosquelettique">Ostéo-articulaire</option>
                <option value="cardiaque">Échographie cardiaque</option>
                <option value="autre">Autre</option>
              </select>
            </div>

            {/* Identifiant patient */}
            <div>
              <label
                htmlFor="patientId"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Identifiant patient (pseudonymisé)
              </label>
              <input
                id="patientId"
                type="text"
                value={patientId}
                onChange={(e) => setPatientId(e.target.value)}
                disabled={etatPipeline !== "idle"}
                placeholder="PAT-2024-0001"
                className="w-full p-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:cursor-not-allowed"
              />
            </div>
          </div>
        </div>

        {/* Enregistreur audio */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
          <AudioRecorder
            modalite={modalite}
            patientId={patientId || undefined}
            onTranscription={handleTranscription}
            onError={handleErreurRecordeur}
            disabled={etatPipeline !== "idle"}
          />
        </div>

        {/* Indicateur de progression du pipeline */}
        {etatPipeline !== "idle" && etatPipeline !== "pret" && (
          <div
            className="flex items-center gap-3 p-4 bg-blue-50 rounded-xl border border-blue-200"
            role="status"
            aria-live="polite"
          >
            <svg
              className="w-5 h-5 text-blue-600 animate-spin flex-shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm text-blue-700">{etapeEnCours}</span>
          </div>
        )}

        {/* Message d'erreur pipeline */}
        {erreurPipeline && (
          <div
            className="p-4 bg-red-50 rounded-xl border border-red-200 text-sm text-red-700"
            role="alert"
          >
            ⚠ {erreurPipeline}
          </div>
        )}

        {/* Éditeur de rapport (affiché dès que les sections sont disponibles) */}
        {sectionsRapport && (
          <>
            <Editor
              rapportId={rapportId}
              patientId={patientId || "patient-inconnu"}
              radiologueId={utilisateurCourant?.uid ?? "utilisateur-inconnu"}
              modalite={modalite}
              sectionsInitiales={sectionsRapport}
              biRads={biRads}
              onSauvegarde={setRapportId}
            />

            {/* Bouton de réinitialisation */}
            <div className="flex justify-center">
              <button
                type="button"
                onClick={reinitialiser}
                className="text-sm text-gray-500 hover:text-gray-700 underline"
              >
                Commencer une nouvelle dictée
              </button>
            </div>
          </>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Panneau Dr Vox (latéral) */}
      {/* ------------------------------------------------------------------ */}
      <div className="hidden lg:block flex-shrink-0">
        <DrVoxChat
          contexteRapport={sectionsRapport}
          visible={drVoxVisible}
          onFermer={() => setDrVoxVisible(false)}
        />
        {!drVoxVisible && (
          <button
            type="button"
            onClick={() => setDrVoxVisible(true)}
            className="fixed bottom-8 right-8 w-14 h-14 bg-blue-700 text-white rounded-full shadow-lg hover:bg-blue-800 transition-colors flex items-center justify-center text-sm font-bold"
            aria-label="Ouvrir Dr Vox"
          >
            DV
          </button>
        )}
      </div>
    </div>
  );
};

export default PageDictee;
