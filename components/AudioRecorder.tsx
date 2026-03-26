/**
 * @file components/AudioRecorder.tsx
 * @description Composant React d'enregistrement audio pour les dictées radiologiques.
 *
 * Ce composant gère le cycle de vie complet de l'enregistrement audio :
 * 1. Demande d'autorisation d'accès au microphone
 * 2. Démarrage/arrêt de l'enregistrement via l'API MediaRecorder (WebM/Opus)
 * 3. Encodage de l'audio en Base64
 * 4. Envoi à la Cloud Function `transcriptionFlow` via Firebase Functions SDK
 * 5. Affichage du statut en temps réel (idle, recording, processing, done, error)
 *
 * Accessibilité :
 * - Indicateur visuel d'enregistrement (cercle rouge animé)
 * - Timer affichant la durée de l'enregistrement
 * - Messages d'état lisibles par les lecteurs d'écran (aria-live)
 *
 * Gestion d'erreur :
 * - Microphone refusé → message d'erreur explicite
 * - Échec Whisper → indicateur de fallback Web Speech API
 * - Audio trop court (<2s) → avertissement
 *
 * @module components/AudioRecorder
 */

"use client";

import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  type FC,
} from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase";
import type {
  TranscriptionInput,
  TranscriptionOutput,
  Modalite,
} from "@/types";

// ---------------------------------------------------------------------------
// Types locaux au composant
// ---------------------------------------------------------------------------

/**
 * États possibles du composant AudioRecorder.
 * Utilisé pour piloter l'affichage et les contrôles.
 */
type StatutEnregistrement =
  | "idle"         // En attente — prêt à enregistrer
  | "recording"    // Enregistrement en cours
  | "processing"   // Audio envoyé, en attente de la transcription
  | "done"         // Transcription reçue
  | "error";       // Erreur (micro refusé, API échouée, etc.)

/**
 * Props du composant AudioRecorder.
 */
interface AudioRecorderProps {
  /** Modalité sélectionnée pour le court-circuit template normal */
  modalite: Modalite;
  /** Identifiant du patient (pour la traçabilité dans les logs) */
  patientId?: string;
  /** Callback appelé quand la transcription est disponible */
  onTranscription: (texte: string, source: TranscriptionOutput["source"]) => void;
  /** Callback appelé en cas d'erreur */
  onError?: (message: string) => void;
  /** Désactiver le composant (ex. rapport déjà validé) */
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Composant principal
// ---------------------------------------------------------------------------

/**
 * Composant AudioRecorder.
 *
 * Affiche un bouton d'enregistrement avec :
 * - Indicateur visuel rouge pulsant pendant l'enregistrement
 * - Timer de durée
 * - Barre de progression pendant le traitement Whisper
 * - Icônes d'état (microphone, chargement, succès, erreur)
 *
 * @param props - Les props du composant (voir `AudioRecorderProps`)
 */
const AudioRecorder: FC<AudioRecorderProps> = ({
  modalite,
  patientId,
  onTranscription,
  onError,
  disabled = false,
}) => {
  // -------------------------------------------------------------------------
  // État local
  // -------------------------------------------------------------------------

  /** Statut courant de l'enregistrement */
  const [statut, setStatut] = useState<StatutEnregistrement>("idle");

  /** Durée de l'enregistrement en secondes (affiché dans le timer) */
  const [dureeSecondes, setDureeSecondes] = useState<number>(0);

  /** Message d'erreur à afficher à l'utilisateur */
  const [messageErreur, setMessageErreur] = useState<string>("");

  // -------------------------------------------------------------------------
  // Références (ne déclenchent pas de re-render)
  // -------------------------------------------------------------------------

  /** Instance MediaRecorder active (null si pas d'enregistrement) */
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  /** Accumulation des chunks audio reçus par l'événement `ondataavailable` */
  const chunksAudioRef = useRef<Blob[]>([]);

  /** Référence au stream microphone (pour le libérer après enregistrement) */
  const streamRef = useRef<MediaStream | null>(null);

  /** Référence à l'intervalle du timer */
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // -------------------------------------------------------------------------
  // Effets
  // -------------------------------------------------------------------------

  /**
   * Nettoyage à la destruction du composant.
   * Libère le stream microphone et nettoie le timer pour éviter les fuites mémoire.
   */
  useEffect(() => {
    return () => {
      // Arrêter toutes les pistes audio du stream
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      // Nettoyer le timer
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, []);

  // -------------------------------------------------------------------------
  // Gestionnaires d'événements
  // -------------------------------------------------------------------------

  /**
   * Démarre l'enregistrement audio.
   *
   * Étapes :
   * 1. Demande l'accès au microphone via `getUserMedia`
   * 2. Crée un `MediaRecorder` avec le format WebM/Opus (qualité/taille optimale)
   * 3. Configure les handlers `ondataavailable` et `onstop`
   * 4. Démarre le timer d'affichage
   * 5. Lance l'enregistrement
   */
  const demarrerEnregistrement = useCallback(async () => {
    // Réinitialiser l'état
    setMessageErreur("");
    chunksAudioRef.current = [];
    setDureeSecondes(0);

    try {
      // Demander l'accès au microphone
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,       // Mono suffisant pour la parole
          sampleRate: 16000,     // 16kHz optimal pour Whisper
          echoCancellation: true, // Annulation d'écho pour le cabinet
          noiseSuppression: true, // Réduction du bruit de fond
        },
      });
      streamRef.current = stream;

      // Créer le MediaRecorder avec WebM/Opus (meilleur support navigateur)
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      // Accumuler les chunks audio
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          chunksAudioRef.current.push(event.data);
        }
      };

      // Quand l'enregistrement s'arrête, déclencher la transcription
      recorder.onstop = handleEnregistrementTermine;

      // Démarrer le timer d'affichage (rafraîchissement toutes les secondes)
      timerRef.current = setInterval(() => {
        setDureeSecondes((prev) => prev + 1);
      }, 1000);

      // Démarrer l'enregistrement (chunks toutes les 250ms)
      recorder.start(250);
      setStatut("recording");
    } catch (err) {
      // Gestion de l'erreur d'accès au microphone
      const message =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Accès au microphone refusé. Veuillez autoriser l'accès dans les paramètres du navigateur."
          : "Impossible d'accéder au microphone. Vérifiez qu'il est connecté et fonctionnel.";

      setMessageErreur(message);
      setStatut("error");
      onError?.(message);
    }
  }, [onError]);

  /**
   * Arrête l'enregistrement audio.
   * Le traitement se poursuit dans `handleEnregistrementTermine` (déclenché par `onstop`).
   */
  const arreterEnregistrement = useCallback(() => {
    // Arrêter le timer
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    // Arrêter le MediaRecorder (déclenche `onstop`)
    if (mediaRecorderRef.current?.state !== "inactive") {
      mediaRecorderRef.current?.stop();
    }

    // Libérer le stream microphone immédiatement
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    setStatut("processing");
  }, []);

  /**
   * Gestionnaire appelé quand l'enregistrement MediaRecorder se termine.
   *
   * Étapes :
   * 1. Vérifie que l'audio est suffisamment long (>2s)
   * 2. Assemble les chunks en un seul Blob audio
   * 3. Encode le Blob en Base64
   * 4. Appelle la Cloud Function `transcriptionFlow`
   * 5. Transmet le résultat au parent via `onTranscription`
   */
  const handleEnregistrementTermine = useCallback(async () => {
    // Vérifier la durée minimale de l'enregistrement
    if (dureeSecondes < 2) {
      const message = "L'enregistrement est trop court (minimum 2 secondes).";
      setMessageErreur(message);
      setStatut("error");
      onError?.(message);
      return;
    }

    // Assembler tous les chunks en un seul Blob
    const blob = new Blob(chunksAudioRef.current, { type: "audio/webm" });

    try {
      // Convertir le Blob en Base64 pour l'envoi à la Cloud Function
      const audioBase64 = await blobEnBase64(blob);

      // Appeler la Cloud Function de transcription
      const transcriptionFn = httpsCallable<TranscriptionInput, TranscriptionOutput>(
        functions,
        "transcription"
      );

      const resultat = await transcriptionFn({
        audioBase64,
        modalite,
        patientId,
      });

      // Transmettre le texte transcrit au composant parent
      onTranscription(resultat.data.texte, resultat.data.source);
      setStatut("done");
    } catch (err) {
      const message =
        "Échec de la transcription. Vérifiez votre connexion et réessayez.";
      setMessageErreur(message);
      setStatut("error");
      onError?.(message);
      console.error("[AudioRecorder] Erreur transcription:", err);
    }
  }, [dureeSecondes, modalite, patientId, onTranscription, onError]);

  // -------------------------------------------------------------------------
  // Fonctions utilitaires
  // -------------------------------------------------------------------------

  /**
   * Convertit un Blob audio en chaîne Base64.
   *
   * Utilise l'API `FileReader` du navigateur pour la conversion asynchrone.
   * La chaîne Base64 résultante ne contient pas le préfixe data URI
   * (ex. "data:audio/webm;base64,") car l'API OpenAI n'en a pas besoin.
   *
   * @param blob - Le Blob audio à convertir.
   * @returns La chaîne Base64 pure.
   */
  const blobEnBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        // Retirer le préfixe "data:audio/webm;base64,"
        const base64 = result.split(",")[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  /**
   * Formate une durée en secondes en chaîne MM:SS.
   *
   * @param secondes - Nombre de secondes à formater.
   * @returns La durée formatée (ex. "02:34").
   */
  const formaterDuree = (secondes: number): string => {
    const min = Math.floor(secondes / 60)
      .toString()
      .padStart(2, "0");
    const sec = (secondes % 60).toString().padStart(2, "0");
    return `${min}:${sec}`;
  };

  // -------------------------------------------------------------------------
  // Rendu
  // -------------------------------------------------------------------------

  return (
    <div className="flex flex-col items-center gap-4 p-6" role="region" aria-label="Enregistreur audio">
      {/* Bouton principal d'enregistrement */}
      <button
        type="button"
        onClick={statut === "recording" ? arreterEnregistrement : demarrerEnregistrement}
        disabled={disabled || statut === "processing"}
        aria-label={statut === "recording" ? "Arrêter l'enregistrement" : "Démarrer l'enregistrement"}
        className={[
          "relative flex items-center justify-center",
          "w-20 h-20 rounded-full transition-all duration-200",
          "focus:outline-none focus:ring-4 focus:ring-offset-2",
          statut === "recording"
            ? "bg-red-600 hover:bg-red-700 focus:ring-red-300 animate-pulse"
            : statut === "processing"
            ? "bg-gray-400 cursor-not-allowed"
            : disabled
            ? "bg-gray-200 cursor-not-allowed"
            : "bg-blue-600 hover:bg-blue-700 focus:ring-blue-300",
        ].join(" ")}
      >
        {/* Icône selon le statut */}
        {statut === "recording" ? (
          // Carré d'arrêt
          <span className="w-8 h-8 bg-white rounded-sm" aria-hidden="true" />
        ) : statut === "processing" ? (
          // Spinner de chargement
          <svg
            className="w-8 h-8 text-white animate-spin"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          // Icône microphone (SVG)
          <svg
            className="w-8 h-8 text-white"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
            <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
          </svg>
        )}
      </button>

      {/* Timer d'enregistrement */}
      {statut === "recording" && (
        <div
          className="text-2xl font-mono font-bold text-red-600"
          aria-live="polite"
          aria-atomic="true"
        >
          {formaterDuree(dureeSecondes)}
        </div>
      )}

      {/* Message de statut */}
      <div
        className="text-sm text-center"
        aria-live="polite"
        aria-atomic="true"
      >
        {statut === "idle" && (
          <span className="text-gray-500">Cliquez pour démarrer la dictée</span>
        )}
        {statut === "recording" && (
          <span className="text-red-600 font-medium">Enregistrement en cours…</span>
        )}
        {statut === "processing" && (
          <span className="text-blue-600">Transcription en cours (Whisper)…</span>
        )}
        {statut === "done" && (
          <span className="text-green-600 font-medium">✓ Transcription terminée</span>
        )}
        {statut === "error" && (
          <span className="text-red-600 font-medium">⚠ {messageErreur}</span>
        )}
      </div>

      {/* Bouton de réinitialisation après erreur */}
      {statut === "error" && (
        <button
          type="button"
          onClick={() => {
            setStatut("idle");
            setMessageErreur("");
          }}
          className="text-sm text-blue-600 underline hover:text-blue-800"
        >
          Réessayer
        </button>
      )}
    </div>
  );
};

export default AudioRecorder;
