/**
 * @file components/DrVoxChat.tsx
 * @description Interface de chat avec l'assistant IA Dr Vox.
 *
 * Ce composant fournit un panneau de chat latéral permettant au radiologue
 * d'interagir avec l'assistant Dr Vox. L'interface supporte :
 *
 * - **Chat multi-tours** : l'historique est maintenu en état local et
 *   envoyé à chaque appel pour la cohérence de la conversation.
 * - **Contexte du rapport** : les sections du rapport en cours sont
 *   transmises au flow pour des réponses contextualisées.
 * - **Sources RAG** : affichage des sources documentaires utilisées
 *   (guidelines ACR, SFR) avec la possibilité de les déplier.
 * - **Raisonnement explicable** : affichage optionnel du chain-of-thought
 *   de Gemini (section "Voir le raisonnement" dépliable).
 * - **Questions suggérées** : chips de questions fréquentes pour
 *   démarrer la conversation rapidement.
 *
 * Accessibilité :
 * - Zone de chat avec `role="log"` et `aria-live="polite"`
 * - Focus automatique sur le champ de saisie
 * - Navigation clavier (Entrée pour envoyer)
 *
 * @module components/DrVoxChat
 */

"use client";

import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  type FC,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase";
import type { DrVoxInput, DrVoxOutput, SectionsRapport } from "@/types";

// ---------------------------------------------------------------------------
// Types locaux
// ---------------------------------------------------------------------------

/**
 * Un message dans la conversation Dr Vox.
 */
interface MessageChat {
  /** Identifiant unique du message */
  id: string;
  /** Auteur du message */
  role: "user" | "assistant";
  /** Contenu textuel du message */
  contenu: string;
  /** Horodatage du message */
  timestamp: Date;
  /** Sources documentaires (pour les messages de l'assistant) */
  sources?: DrVoxOutput["sources"];
  /** Raisonnement chain-of-thought (pour les messages de l'assistant) */
  raisonnement?: string;
  /** Si le message est en cours de chargement */
  enChargement?: boolean;
}

/**
 * Props du composant DrVoxChat.
 */
interface DrVoxChatProps {
  /** Sections du rapport en cours pour le contexte des réponses */
  contexteRapport?: Partial<SectionsRapport>;
  /** Afficher ou masquer le panneau de chat */
  visible?: boolean;
  /** Callback pour fermer le panneau */
  onFermer?: () => void;
}

// ---------------------------------------------------------------------------
// Données statiques
// ---------------------------------------------------------------------------

/**
 * Nombre maximum de messages d'historique conservés dans le composant DrVoxChat.
 * Correspond à MAX_HISTORY_MESSAGES côté serveur pour la cohérence.
 */
const MAX_HISTORIQUE_LOCAL = 6;
 * Couvrent les cas d'usage les plus fréquents de Dr Vox.
 */
const QUESTIONS_SUGGEREES = [
  "Critères ACR BI-RADS 4B ?",
  "Conduite à tenir TIRADS 4, 15mm ?",
  "Formulation pour scanner thoracique normal ?",
  "Critères de malignité d'un nodule thyroïdien ?",
  "Que signifie LI-RADS 3 ?",
];

// ---------------------------------------------------------------------------
// Composant principal
// ---------------------------------------------------------------------------

/**
 * Composant DrVoxChat.
 *
 * Panneau latéral de chat avec Dr Vox, l'assistant IA radiologique de RadIA.
 *
 * @param props - Les props du composant (voir `DrVoxChatProps`)
 */
const DrVoxChat: FC<DrVoxChatProps> = ({
  contexteRapport,
  visible = true,
  onFermer,
}) => {
  // -------------------------------------------------------------------------
  // État local
  // -------------------------------------------------------------------------

  /** Historique des messages de la conversation */
  const [messages, setMessages] = useState<MessageChat[]>([
    {
      id: "welcome",
      role: "assistant",
      contenu:
        "Bonjour ! Je suis Dr Vox, votre assistant radiologique IA. " +
        "Posez-moi vos questions sur les classifications, les conduites à tenir, " +
        "ou demandez-moi d'améliorer votre rapport.",
      timestamp: new Date(),
    },
  ]);

  /** Texte saisi dans le champ de question */
  const [questionSaisie, setQuestionSaisie] = useState<string>("");

  /** Indique si une réponse est en cours de génération */
  const [enChargement, setEnChargement] = useState<boolean>(false);

  // -------------------------------------------------------------------------
  // Références
  // -------------------------------------------------------------------------

  /** Référence pour le scroll automatique vers le bas */
  const endOfMessagesRef = useRef<HTMLDivElement | null>(null);

  /** Référence pour le focus sur le champ de saisie */
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // -------------------------------------------------------------------------
  // Effets
  // -------------------------------------------------------------------------

  /**
   * Scroll automatique vers le dernier message.
   * Déclenché à chaque ajout de message dans la liste.
   */
  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  /**
   * Focus automatique sur le champ de saisie quand le panneau devient visible.
   */
  useEffect(() => {
    if (visible) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [visible]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * Envoie la question à Dr Vox et affiche la réponse.
   *
   * Étapes :
   * 1. Valide que la question n'est pas vide
   * 2. Ajoute le message utilisateur à l'historique
   * 3. Ajoute un message "en chargement" pour l'assistant
   * 4. Appelle la Cloud Function `drVoxFlow`
   * 5. Remplace le message de chargement par la vraie réponse
   *
   * @param question - La question à envoyer (depuis le formulaire ou suggestion).
   */
  const envoyerQuestion = useCallback(
    async (question: string) => {
      const texteQuestion = question.trim();
      if (!texteQuestion || enChargement) return;

      // Réinitialiser le champ de saisie
      setQuestionSaisie("");
      setEnChargement(true);

      // ID unique pour le message de l'assistant (pour le remplacer après réponse)
      const idMessageAssistant = `assistant-${Date.now()}`;

      // Ajouter les deux messages en une seule mise à jour d'état
      setMessages((prev) => [
        ...prev,
        // Message de l'utilisateur
        {
          id: `user-${Date.now()}`,
          role: "user",
          contenu: texteQuestion,
          timestamp: new Date(),
        },
        // Message de chargement (sera remplacé par la vraie réponse)
        {
          id: idMessageAssistant,
          role: "assistant",
          contenu: "",
          timestamp: new Date(),
          enChargement: true,
        },
      ]);

      try {
        // Construire l'historique pour le mode multi-tours
        // (exclure le message de bienvenue et le message de chargement actuel)
        const historique = messages
          .filter((m) => m.id !== "welcome" && !m.enChargement)
        .slice(-MAX_HISTORIQUE_LOCAL) // Garder les MAX_HISTORIQUE_LOCAL derniers échanges
          .map((m) => ({ role: m.role, contenu: m.contenu }));

        // Appeler la Cloud Function Dr Vox
        const drVoxFn = httpsCallable<DrVoxInput, DrVoxOutput>(
          functions,
          "drVox"
        );

        const resultat = await drVoxFn({
          question: texteQuestion,
          contexteRapport: contexteRapport ?? undefined,
          historique,
        });

        // Remplacer le message de chargement par la vraie réponse
        setMessages((prev) =>
          prev.map((m) =>
            m.id === idMessageAssistant
              ? {
                  ...m,
                  contenu: resultat.data.reponse,
                  sources: resultat.data.sources,
                  raisonnement: resultat.data.raisonnement,
                  enChargement: false,
                }
              : m
          )
        );
      } catch (err) {
        // En cas d'erreur, remplacer le message de chargement par un message d'erreur
        setMessages((prev) =>
          prev.map((m) =>
            m.id === idMessageAssistant
              ? {
                  ...m,
                  contenu:
                    "Désolé, je n'ai pas pu répondre à votre question. " +
                    "Vérifiez votre connexion et réessayez.",
                  enChargement: false,
                }
              : m
          )
        );
        console.error("[DrVoxChat] Erreur:", err);
      } finally {
        setEnChargement(false);
      }
    },
    [enChargement, messages, contexteRapport]
  );

  /**
   * Gestionnaire de soumission du formulaire.
   *
   * @param event - L'événement de soumission HTML.
   */
  const handleSoumission = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      envoyerQuestion(questionSaisie);
    },
    [questionSaisie, envoyerQuestion]
  );

  /**
   * Envoie le message avec Entrée (Shift+Entrée pour saut de ligne).
   *
   * @param event - L'événement clavier.
   */
  const handleToucheClavier = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        envoyerQuestion(questionSaisie);
      }
    },
    [questionSaisie, envoyerQuestion]
  );

  // -------------------------------------------------------------------------
  // Rendu (retourne null si non visible)
  // -------------------------------------------------------------------------

  if (!visible) return null;

  return (
    <aside
      className="flex flex-col h-full bg-gray-50 border-l border-gray-200 w-96"
      aria-label="Assistant Dr Vox"
    >
      {/* En-tête du panneau */}
      <div className="flex items-center justify-between px-4 py-3 bg-blue-700 text-white">
        <div className="flex items-center gap-2">
          {/* Icône Dr Vox */}
          <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-sm font-bold">
            DV
          </div>
          <div>
            <h2 className="text-sm font-semibold">Dr Vox</h2>
            <p className="text-xs text-blue-200">Assistant IA Radiologique</p>
          </div>
        </div>
        {/* Bouton de fermeture */}
        {onFermer && (
          <button
            type="button"
            onClick={onFermer}
            aria-label="Fermer Dr Vox"
            className="text-blue-200 hover:text-white transition-colors"
          >
            ✕
          </button>
        )}
      </div>

      {/* Zone de messages */}
      <div
        className="flex-1 overflow-y-auto p-4 space-y-4"
        role="log"
        aria-label="Conversation avec Dr Vox"
        aria-live="polite"
      >
        {messages.map((message) => (
          <BulleMessage key={message.id} message={message} />
        ))}
        {/* Ancre de scroll automatique */}
        <div ref={endOfMessagesRef} aria-hidden="true" />
      </div>

      {/* Questions suggérées (affichées seulement au début) */}
      {messages.length === 1 && (
        <div className="px-4 py-3 border-t border-gray-200">
          <p className="text-xs text-gray-500 mb-2">Questions fréquentes :</p>
          <div className="flex flex-wrap gap-1">
            {QUESTIONS_SUGGEREES.map((question) => (
              <button
                key={question}
                type="button"
                onClick={() => envoyerQuestion(question)}
                className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded-full hover:bg-blue-100 border border-blue-200 transition-colors"
              >
                {question}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Formulaire de saisie */}
      <form
        onSubmit={handleSoumission}
        className="flex gap-2 p-4 border-t border-gray-200 bg-white"
      >
        <textarea
          ref={inputRef}
          value={questionSaisie}
          onChange={(e) => setQuestionSaisie(e.target.value)}
          onKeyDown={handleToucheClavier}
          placeholder="Posez votre question… (Entrée pour envoyer)"
          rows={2}
          disabled={enChargement}
          aria-label="Question pour Dr Vox"
          className={[
            "flex-1 text-sm p-2 rounded-lg border resize-none",
            "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent",
            enChargement ? "opacity-50 cursor-not-allowed" : "",
          ].join(" ")}
        />
        <button
          type="submit"
          disabled={enChargement || !questionSaisie.trim()}
          aria-label="Envoyer la question"
          className="self-end px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {enChargement ? (
            <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            "→"
          )}
        </button>
      </form>
    </aside>
  );
};

// ---------------------------------------------------------------------------
// Sous-composant : Bulle de message
// ---------------------------------------------------------------------------

/**
 * Props du sous-composant BulleMessage.
 */
interface BulleMessageProps {
  /** Le message à afficher */
  message: MessageChat;
}

/**
 * Bulle de message individuelle dans le chat Dr Vox.
 *
 * Affiche le contenu du message avec :
 * - Alignement à droite pour l'utilisateur, à gauche pour l'assistant
 * - Indicateur animé si le message est en cours de chargement
 * - Section "Sources" dépliable pour les messages de l'assistant
 * - Section "Raisonnement" dépliable pour le chain-of-thought
 *
 * @param props - Message à afficher (voir `BulleMessageProps`)
 */
const BulleMessage: FC<BulleMessageProps> = ({ message }) => {
  /** État d'expansion des sources documentaires */
  const [sourcesDepliees, setSourcesDepliees] = useState(false);

  /** État d'expansion du raisonnement chain-of-thought */
  const [raisonnementDeplie, setRaisonnementDeplie] = useState(false);

  const estUtilisateur = message.role === "user";

  return (
    <div
      className={`flex flex-col gap-1 ${estUtilisateur ? "items-end" : "items-start"}`}
    >
      <div
        className={[
          "max-w-[85%] px-3 py-2 rounded-xl text-sm leading-relaxed",
          estUtilisateur
            ? "bg-blue-600 text-white rounded-br-none"
            : "bg-white text-gray-800 border border-gray-200 rounded-bl-none shadow-sm",
        ].join(" ")}
      >
        {/* Indicateur de chargement */}
        {message.enChargement ? (
          <div className="flex gap-1 items-center h-4" aria-label="Dr Vox est en train de répondre">
            <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
            <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
            <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
          </div>
        ) : (
          message.contenu
        )}
      </div>

      {/* Sources documentaires (pour les messages assistant) */}
      {!estUtilisateur && message.sources && message.sources.length > 0 && (
        <div className="max-w-[85%] w-full">
          <button
            type="button"
            onClick={() => setSourcesDepliees((p) => !p)}
            className="text-xs text-blue-600 hover:underline"
          >
            {sourcesDepliees ? "▲ Masquer les sources" : "▼ Voir les sources"} ({message.sources.length})
          </button>
          {sourcesDepliees && (
            <ul className="mt-1 space-y-1">
              {message.sources.map((source, idx) => (
                <li
                  key={idx}
                  className="text-xs bg-blue-50 border border-blue-100 rounded p-2 text-gray-700"
                >
                  <span className="font-semibold">{source.titre}</span>
                  <br />
                  <span className="text-gray-600">{source.extrait}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Raisonnement chain-of-thought */}
      {!estUtilisateur && message.raisonnement && (
        <div className="max-w-[85%] w-full">
          <button
            type="button"
            onClick={() => setRaisonnementDeplie((p) => !p)}
            className="text-xs text-gray-400 hover:text-gray-600"
          >
            {raisonnementDeplie ? "▲ Masquer le raisonnement" : "▼ Voir le raisonnement"}
          </button>
          {raisonnementDeplie && (
            <p className="mt-1 text-xs text-gray-500 bg-gray-100 rounded p-2 italic">
              {message.raisonnement}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default DrVoxChat;
