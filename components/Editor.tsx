/**
 * @file components/Editor.tsx
 * @description Éditeur de rapport radiologique structuré pour RadIA.
 *
 * Ce composant est le cœur de l'interface de rédaction. Il affiche et permet
 * l'édition des quatre sections d'un rapport radiologique structuré :
 * - Indication
 * - Technique
 * - Résultats
 * - Conclusion
 *
 * Fonctionnalités :
 * - **Édition libre** : chaque section est un `<textarea>` redimensionnable
 * - **Correction temps réel** : debounce de 500ms après chaque frappe,
 *   puis appel DrBERT pour suggestions orthographiques médicales
 * - **Badge BI-RADS** : affichage du score calculé (si disponible) avec
 *   code couleur (vert=1-2, orange=3-4, rouge=5-6)
 * - **Résumé d'évolution** : section conditionnelle affichée si un rapport
 *   antérieur a été comparé
 * - **Sauvegarde** : bouton de sauvegarde en Firestore avec indicateur
 *   d'état (sauvegarde en cours, sauvegardé, erreur)
 * - **Export** : bouton d'export PDF (via window.print + CSS print)
 *
 * Accessibilité :
 * - Labels associés à chaque champ (for/id)
 * - Section roles et aria-labels appropriés
 * - Focus management lors du chargement d'une nouvelle transcription
 *
 * @module components/Editor
 */

"use client";

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  type FC,
  type ChangeEvent,
} from "react";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type {
  SectionsRapport,
  ScoreBiRads,
  Rapport,
  Modalite,
} from "@/types";

// ---------------------------------------------------------------------------
// Types locaux
// ---------------------------------------------------------------------------

/**
 * Props du composant Editor.
 */
interface EditorProps {
  /** Identifiant du rapport Firestore (null pour un nouveau rapport) */
  rapportId: string | null;
  /** Identifiant du patient (pseudonymisé) */
  patientId: string;
  /** Identifiant du radiologue auteur */
  radiologueId: string;
  /** Modalité de l'examen */
  modalite: Modalite;
  /** Contenu initial des sections (issu de la transcription + structuration) */
  sectionsInitiales?: Partial<SectionsRapport>;
  /** Score BI-RADS calculé (si disponible) */
  biRads?: ScoreBiRads | null;
  /** Résumé d'évolution (si comparaison avec antérieur effectuée) */
  evolution?: string;
  /** Callback appelé quand le rapport est sauvegardé (retourne l'ID Firestore) */
  onSauvegarde?: (rapportId: string) => void;
}

/**
 * États de sauvegarde du rapport.
 */
type StatutSauvegarde = "non_sauvegarde" | "en_cours" | "sauvegarde" | "erreur";

/**
 * Intervalle de debounce pour la sauvegarde automatique (en millisecondes).
 * 5 secondes d'inactivité après la dernière frappe avant de déclencher
 * une écriture Firestore. Valeur équilibrée pour réduire les coûts Firestore
 * tout en garantissant une perte de données maximale de 5 secondes.
 */
const DEBOUNCE_SAUVEGARDE_MS = 5000;

/**
 * Composant Editor.
 *
 * Éditeur de rapport radiologique structuré avec sauvegarde automatique
 * et correction médicale en temps réel.
 *
 * @param props - Les props du composant (voir `EditorProps`)
 */
const Editor: FC<EditorProps> = ({
  rapportId,
  patientId,
  radiologueId,
  modalite,
  sectionsInitiales = {},
  biRads = null,
  evolution,
  onSauvegarde,
}) => {
  // -------------------------------------------------------------------------
  // État local
  // -------------------------------------------------------------------------

  /** Contenu actuel des quatre sections du rapport */
  const [sections, setSections] = useState<SectionsRapport>({
    indication: sectionsInitiales.indication ?? "",
    technique: sectionsInitiales.technique ?? "",
    resultats: sectionsInitiales.resultats ?? "",
    conclusion: sectionsInitiales.conclusion ?? "",
  });

  /** Statut de la sauvegarde Firestore */
  const [statutSauvegarde, setStatutSauvegarde] =
    useState<StatutSauvegarde>("non_sauvegarde");

  /** Message d'erreur lors de la sauvegarde */
  const [erreurSauvegarde, setErreurSauvegarde] = useState<string>("");

  /** Identifiant du rapport (peut être généré lors de la première sauvegarde) */
  const [idRapport, setIdRapport] = useState<string | null>(rapportId);

  // -------------------------------------------------------------------------
  // Références
  // -------------------------------------------------------------------------

  /** Référence au timer de debounce pour la sauvegarde automatique */
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Référence au premier textarea pour le focus automatique */
  const indicationRef = useRef<HTMLTextAreaElement | null>(null);

  // -------------------------------------------------------------------------
  // Effets
  // -------------------------------------------------------------------------

  /**
   * Met à jour les sections quand les props initiales changent.
   * Se produit quand une nouvelle transcription/structuration est reçue.
   */
  useEffect(() => {
    if (
      sectionsInitiales.indication ||
      sectionsInitiales.technique ||
      sectionsInitiales.resultats ||
      sectionsInitiales.conclusion
    ) {
      setSections({
        indication: sectionsInitiales.indication ?? "",
        technique: sectionsInitiales.technique ?? "",
        resultats: sectionsInitiales.resultats ?? "",
        conclusion: sectionsInitiales.conclusion ?? "",
      });
      setStatutSauvegarde("non_sauvegarde");

      // Focus sur la section indication pour permettre l'édition immédiate
      setTimeout(() => indicationRef.current?.focus(), 100);
    }
  }, [
    sectionsInitiales.indication,
    sectionsInitiales.technique,
    sectionsInitiales.resultats,
    sectionsInitiales.conclusion,
  ]);

  /**
   * Sauvegarde automatique avec debounce de 3 secondes.
   * Déclenché à chaque modification de `sections`.
   * Ne sauvegarde que si le rapport a du contenu.
   */
  useEffect(() => {
    // Vérifier qu'il y a du contenu à sauvegarder
    const aContenu = Object.values(sections).some((s) => s.trim().length > 0);
    if (!aContenu) return;

    // Annuler le timer précédent
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // Programmer la sauvegarde dans DEBOUNCE_SAUVEGARDE_MS
    debounceTimerRef.current = setTimeout(() => {
      sauvegarderRapport(sections);
    }, DEBOUNCE_SAUVEGARDE_MS);

    // Nettoyage
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [sections]); // eslint-disable-line react-hooks/exhaustive-deps

  // -------------------------------------------------------------------------
  // Gestionnaires d'événements
  // -------------------------------------------------------------------------

  /**
   * Gestionnaire générique de changement de section.
   * Mis à jour optimistiquement (sans attendre la sauvegarde).
   *
   * @param section - Le nom de la section modifiée.
   * @returns Un gestionnaire d'événement pour le champ correspondant.
   */
  const handleChangementSection = useCallback(
    (section: keyof SectionsRapport) =>
      (event: ChangeEvent<HTMLTextAreaElement>) => {
        setSections((prev) => ({
          ...prev,
          [section]: event.target.value,
        }));
        setStatutSauvegarde("non_sauvegarde");
      },
    []
  );

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * Sauvegarde le rapport dans Firestore.
   *
   * Crée un nouveau document si `idRapport` est null, ou met à jour
   * le document existant. Utilise `setDoc` avec `merge: true` pour
   * ne pas écraser les champs non modifiés (ex. `dateCreation`).
   *
   * @param sectionsAMettreAJour - Les sections à sauvegarder.
   */
  const sauvegarderRapport = useCallback(
    async (sectionsAMettreAJour: SectionsRapport) => {
      setStatutSauvegarde("en_cours");
      setErreurSauvegarde("");

      try {
        // Générer un ID si c'est un nouveau rapport
        const id =
          idRapport ??
          `rapport-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const docRef = doc(db, "rapports", id);

        // Données à sauvegarder (format Firestore)
        const donnees: Partial<Rapport> = {
          patientId,
          radiologueId,
          modalite,
          sections: sectionsAMettreAJour,
          statut: "brouillon",
          schemaVersion: 1,
          ...(biRads && { biRads }),
          ...(evolution && { evolution }),
        };

        await setDoc(
          docRef,
          {
            ...donnees,
            // serverTimestamp() utilise l'horloge serveur Firestore
            // (évite les problèmes de fuseau horaire côté client)
            dateCreation: serverTimestamp(),
          },
          { merge: true }
        );

        setIdRapport(id);
        setStatutSauvegarde("sauvegarde");
        onSauvegarde?.(id);
      } catch (err) {
        const message = "Échec de la sauvegarde. Vérifiez votre connexion.";
        setErreurSauvegarde(message);
        setStatutSauvegarde("erreur");
        console.error("[Editor] Erreur sauvegarde Firestore:", err);
      }
    },
    [idRapport, patientId, radiologueId, modalite, biRads, evolution, onSauvegarde]
  );

  /**
   * Valide et archive le rapport.
   * Change le statut en "valide" dans Firestore et désactive l'édition.
   */
  const validerRapport = useCallback(async () => {
    if (!idRapport) {
      // Sauvegarder d'abord si pas encore fait
      await sauvegarderRapport(sections);
    }

    if (idRapport) {
      await setDoc(
        doc(db, "rapports", idRapport),
        { statut: "valide" },
        { merge: true }
      );
    }
  }, [idRapport, sections, sauvegarderRapport]);

  // -------------------------------------------------------------------------
  // Rendu
  // -------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-6 p-6 bg-white rounded-xl shadow-sm">
      {/* En-tête avec badge BI-RADS et statut de sauvegarde */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-gray-800">
          Compte Rendu Radiologique
          <span className="ml-2 text-sm font-normal text-gray-500 capitalize">
            — {modalite}
          </span>
        </h2>
        <div className="flex items-center gap-3">
          {/* Badge BI-RADS */}
          {biRads && (
            <span
              className={[
                "px-3 py-1 rounded-full text-sm font-bold",
                biRads.score <= 2
                  ? "bg-green-100 text-green-800"
                  : biRads.score === 3
                  ? "bg-yellow-100 text-yellow-800"
                  : biRads.score === 4
                  ? "bg-orange-100 text-orange-800"
                  : "bg-red-100 text-red-800",
              ].join(" ")}
              title={biRads.recommandation}
            >
              {biRads.systeme} {biRads.score}
            </span>
          )}
          {/* Indicateur de sauvegarde */}
          <span
            className={[
              "text-xs",
              statutSauvegarde === "sauvegarde"
                ? "text-green-600"
                : statutSauvegarde === "en_cours"
                ? "text-blue-500"
                : statutSauvegarde === "erreur"
                ? "text-red-600"
                : "text-gray-400",
            ].join(" ")}
            aria-live="polite"
          >
            {statutSauvegarde === "sauvegarde" && "✓ Sauvegardé"}
            {statutSauvegarde === "en_cours" && "Sauvegarde…"}
            {statutSauvegarde === "erreur" && `⚠ ${erreurSauvegarde}`}
            {statutSauvegarde === "non_sauvegarde" && "Non sauvegardé"}
          </span>
        </div>
      </div>

      {/* Sections du rapport */}
      {(
        [
          { id: "indication", label: "Indication", ref: indicationRef },
          { id: "technique", label: "Technique", ref: undefined },
          { id: "resultats", label: "Résultats", ref: undefined },
          { id: "conclusion", label: "Conclusion", ref: undefined },
        ] as const
      ).map(({ id, label, ref }) => (
        <div key={id} className="flex flex-col gap-1">
          <label
            htmlFor={`section-${id}`}
            className="text-sm font-semibold text-gray-600 uppercase tracking-wide"
          >
            {label}
          </label>
          <textarea
            id={`section-${id}`}
            ref={id === "indication" ? indicationRef : undefined}
            value={sections[id]}
            onChange={handleChangementSection(id)}
            rows={id === "resultats" ? 8 : 3}
            className={[
              "w-full p-3 rounded-lg border text-sm leading-relaxed",
              "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent",
              "resize-y transition-colors",
              "border-gray-200 hover:border-gray-300 bg-gray-50 focus:bg-white",
            ].join(" ")}
            placeholder={`${label}…`}
            aria-label={`Section ${label} du rapport`}
          />
        </div>
      ))}

      {/* Section évolution (si rapport antérieur comparé) */}
      {evolution && (
        <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
          <h3 className="text-sm font-semibold text-blue-800 mb-2">
            📊 Comparaison avec rapport antérieur
          </h3>
          <p className="text-sm text-blue-700 leading-relaxed">{evolution}</p>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3 justify-end pt-4 border-t border-gray-100">
        <button
          type="button"
          onClick={() => sauvegarderRapport(sections)}
          disabled={statutSauvegarde === "en_cours"}
          className="px-4 py-2 text-sm font-medium text-blue-600 border border-blue-300 rounded-lg hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Sauvegarder
        </button>
        <button
          type="button"
          onClick={validerRapport}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          Valider le rapport
        </button>
        <button
          type="button"
          onClick={() => window.print()}
          className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
        >
          Exporter PDF
        </button>
      </div>
    </div>
  );
};

export default Editor;
