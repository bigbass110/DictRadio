# RadIA — Assistant de Transcription Radiologique

[![Next.js](https://img.shields.io/badge/Next.js-14-black?logo=next.js)](https://nextjs.org/)
[![Firebase](https://img.shields.io/badge/Firebase-10-orange?logo=firebase)](https://firebase.google.com/)
[![Genkit](https://img.shields.io/badge/Genkit-0.5-blue?logo=google)](https://firebase.google.com/docs/genkit)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Description

**RadIA** est un assistant intelligent de transcription et de structuration de **comptes rendus radiologiques**. Il transforme une dictée audio du radiologue en un compte rendu structuré, validé et archivé, en exploitant une chaîne de modèles IA médicaux :

| Modèle | Rôle |
|--------|------|
| **OpenAI Whisper** | Transcription audio → texte brut |
| **DrBERT / CamemBERT-bio** | Correction orthographique et terminologie médicale |
| **RadPhi-3** (Microsoft) | Structuration sémantique du rapport radiologique |
| **Gemini (Google)** | Raisonnement explicable, classification BI-RADS, assistant Dr Vox |

### Fonctionnalités clés

- 🎙️ **Dictée audio** temps réel (WebM/Opus) avec transcription automatique
- 🔄 **Court-circuit protocole normal** : détection automatique et remplacement par template pré-écrit
- 🏗️ **Structuration IA** : séparation indication / technique / résultats / conclusion
- 🎯 **Classification BI-RADS** assistée (sein, thyroïde, foie, rein)
- 📊 **Comparaison avec antérieurs** : mise en évidence des évolutions lésionnelles
- 💬 **Dr Vox** : assistant IA contextuel (chat RAG + raisonnement explicable)
- ✏️ **Éditeur enrichi** avec correction médicale temps réel
- 🔒 **Confidentialité RGPD** : données hébergées sur infrastructure privée / GCP France

---

## Architecture technique

### Vue d'ensemble (couches)

```
┌─────────────────────────────────────────────────────────────────┐
│                     COUCHE PRÉSENTATION                         │
│           Next.js 14 (App Router) + React 18 + Tailwind         │
│   AudioRecorder │ Editor │ DrVoxChat │ BiRadsSelector           │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTPS / Firebase SDK
┌────────────────────────▼────────────────────────────────────────┐
│                  COUCHE ORCHESTRATION                           │
│           Firebase Cloud Functions (Node 20) + Genkit           │
│                                                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐   │
│  │transcription│  │structuration │  │   comparaison       │   │
│  │   Flow      │  │   Flow       │  │   Flow              │   │
│  └─────────────┘  └──────────────┘  └─────────────────────┘   │
│  ┌─────────────┐  ┌──────────────┐                             │
│  │  birads     │  │   drVox      │                             │
│  │  Flow       │  │   Flow       │                             │
│  └─────────────┘  └──────────────┘                             │
└──────┬──────────────────┬─────────────────┬────────────────────┘
       │                  │                 │
┌──────▼──────┐  ┌────────▼───────┐  ┌─────▼──────────────────┐
│  COUCHE IA  │  │ COUCHE DONNÉES │  │  COUCHE SÉCURITÉ        │
│             │  │                │  │                          │
│ • Whisper   │  │ • Firestore    │  │ • Firebase Auth (IAM)    │
│   (OpenAI)  │  │   - rapports   │  │ • Firestore Rules        │
│ • DrBERT    │  │   - templates  │  │ • Secret Manager (GCP)   │
│   (HF API)  │  │   - utilisateurs│  │ • CORS strict            │
│ • RadPhi-3  │  │ • Firebase     │  │ • Chiffrement AES-256    │
│   (HF API)  │  │   Storage      │  │   en transit et au repos │
│ • Gemini    │  │   (audio temp) │  │                          │
│   (Google)  │  │                │  │                          │
└─────────────┘  └────────────────┘  └──────────────────────────┘
```

### Flux de données

1. **Acquisition** : le navigateur capture l'audio via `MediaRecorder` (WebM/Opus) et l'encode en Base64.
2. **Transport** : l'audio est envoyé via le Firebase SDK à la Cloud Function `transcriptionFlow`.
3. **Transcription** : Whisper convertit l'audio en texte brut.
4. **Court-circuit** : si le texte contient « normal » et qu'un template existe pour la modalité, on retourne directement le template.
5. **Correction** : DrBERT corrige la terminologie médicale.
6. **Structuration** : RadPhi-3 (ou Gemini en fallback) organise le texte en sections standardisées.
7. **Classification** : le flow BI-RADS extrait les scores si la modalité le requiert.
8. **Comparaison** : si un rapport antérieur existe en Firestore, Gemini met en évidence les évolutions.
9. **Persistance** : le rapport final est sauvegardé dans Firestore avec horodatage et signature.
10. **Interface** : l'éditeur affiche le rapport structuré ; Dr Vox est disponible pour les questions.

---

## Workflow fonctionnel détaillé

### Parcours nominal d'une dictée

```
Radiologue
    │
    ▼ (1) Sélectionne modalité + patient
[AudioRecorder]
    │ (2) Démarre enregistrement WebM/Opus
    │ (3) Arrête et encode en Base64
    │
    ▼ (4) Appel HTTPS à Cloud Function
[transcriptionFlow]
    │ (5) Whisper → texte brut
    │
    ├─── (6a) "normal" détecté + template disponible ?
    │         └─► Retourner template pré-écrit (court-circuit)
    │
    └─── (6b) Sinon : DrBERT → texte corrigé
                        │
                        ▼ (7) RadPhi-3 → structuration
                   [structurationFlow]
                        │
                        ├─── (8a) Modalité mammaire/thyroïde ?
                        │         └─► [biradsFlow] → score BI-RADS
                        │
                        └─── (8b) Rapport antérieur disponible ?
                                  └─► [comparaisonFlow] → delta lésionnel
                                        │
                                        ▼ (9) Rapport final assemblé
                                   [Editor]
                                        │
                                        ▼ (10) Sauvegarde Firestore
                                   [Rapport archivé]
```

### Cas particuliers

| Scénario | Comportement |
|----------|-------------|
| **Protocole normal** | Whisper détecte « normal » → template pré-écrit retourné sans appel IA coûteux |
| **Mode IA** | Pipeline complet : Whisper → DrBERT → RadPhi-3 → Gemini |
| **Mode libre** | Pas de structuration automatique ; éditeur texte brut uniquement |
| **BI-RADS mammaire** | `biradsFlow` extrait le score ACR et génère la recommandation |
| **Comparaison antérieur** | `comparaisonFlow` compare lésion par lésion et génère un résumé d'évolution |
| **Dr Vox** | Chat contextuel RAG sur les guidelines radiologiques (ACR, SFR) + Gemini |
| **Erreur Whisper** | Fallback sur transcription navigateur (Web Speech API) |
| **Quota dépassé** | File d'attente Firebase avec retry exponentiel |

---

## Prérequis

- **Node.js** ≥ 20 (LTS)
- **npm** ≥ 10
- **Firebase CLI** ≥ 13 : `npm install -g firebase-tools`
- **Compte Google Cloud** avec les APIs activées :
  - Cloud Functions, Firestore, Firebase Storage, Secret Manager
- **Clés API** :
  - `OPENAI_API_KEY` — OpenAI (Whisper)
  - `HUGGINGFACE_API_KEY` — Hugging Face (DrBERT, RadPhi-3)
  - `GEMINI_API_KEY` — Google AI Studio (Gemini)

---

## Installation

### 1. Cloner le dépôt

```bash
git clone https://github.com/bigbass110/DictRadio.git
cd DictRadio
```

### 2. Installer les dépendances

```bash
# Frontend Next.js
npm install

# Cloud Functions
cd functions
npm install
cd ..
```

### 3. Configurer Firebase

```bash
# Se connecter à Firebase
firebase login

# Initialiser le projet (si pas déjà fait)
firebase use --add   # choisir le projet GCP
```

### 4. Ajouter les secrets

```bash
# Via Firebase Secret Manager (recommandé pour la production)
firebase functions:secrets:set OPENAI_API_KEY
firebase functions:secrets:set HUGGINGFACE_API_KEY
firebase functions:secrets:set GEMINI_API_KEY

# Pour le développement local : copier .env.example
cp .env.example .env.local
# Puis éditer .env.local avec vos valeurs
```

### 5. Configurer les variables d'environnement du frontend

```bash
cp .env.example .env.local
# Éditer .env.local avec les valeurs Firebase de votre projet
```

---

## Structure du projet

```
DictRadio/
│
├── README.md                    # Documentation principale (ce fichier)
├── package.json                 # Dépendances frontend (Next.js, React, Firebase)
├── next.config.js               # Configuration Next.js
├── tsconfig.json                # Configuration TypeScript frontend
├── tailwind.config.ts           # Configuration Tailwind CSS
├── .env.example                 # Template des variables d'environnement
├── firestore.rules              # Règles de sécurité Firestore
├── firebase.json                # Configuration Firebase (hosting, functions, emulators)
│
├── app/                         # Next.js App Router
│   ├── layout.tsx               # Layout racine (providers, fonts)
│   ├── page.tsx                 # Page d'accueil (liste des rapports récents)
│   └── dictation/
│       └── page.tsx             # Page principale de dictée
│
├── components/                  # Composants React réutilisables
│   ├── AudioRecorder.tsx        # Enregistreur audio WebM/Opus
│   ├── Editor.tsx               # Éditeur de rapport structuré
│   └── DrVoxChat.tsx            # Interface chat Dr Vox (assistant IA)
│
├── lib/                         # Bibliothèques et utilitaires
│   └── firebase.ts              # Initialisation du SDK Firebase client
│
├── types/                       # Définitions TypeScript partagées
│   └── index.ts                 # Interfaces et types du domaine médical
│
└── functions/                   # Firebase Cloud Functions
    ├── package.json             # Dépendances des fonctions (Genkit, OpenAI, etc.)
    ├── tsconfig.json            # Configuration TypeScript des fonctions
    └── src/
        ├── index.ts             # Point d'entrée des Cloud Functions
        └── flows/               # Flows Genkit (orchestration IA)
            ├── transcriptionFlow.ts   # Transcription audio → texte (Whisper)
            ├── structurationFlow.ts   # Structuration sémantique (RadPhi-3/Gemini)
            ├── biradsFlow.ts          # Classification BI-RADS assistée
            ├── comparaisonFlow.ts     # Comparaison avec rapport antérieur
            └── drVoxFlow.ts           # Assistant IA Dr Vox (RAG + Gemini)
```

---

## Utilisation

### Lancer en développement local (émulateurs Firebase)

```bash
# Terminal 1 – Émulateurs Firebase (Firestore, Functions, Auth, Storage)
firebase emulators:start

# Terminal 2 – Frontend Next.js
npm run dev
```

L'application est accessible sur `http://localhost:3000`.
L'UI des émulateurs Firebase est sur `http://localhost:4000`.

### Tester les flows avec Genkit UI

```bash
cd functions
npm run genkit:dev
```

L'interface Genkit est accessible sur `http://localhost:4001`.  
Vous pouvez y tester chaque flow individuellement avec des données d'entrée JSON.

### Déployer en production

```bash
# Déployer les Cloud Functions
firebase deploy --only functions

# Déployer le frontend (Firebase Hosting)
npm run build
firebase deploy --only hosting

# Déployer les règles Firestore
firebase deploy --only firestore:rules

# Tout déployer en une seule commande
firebase deploy
```

---

## Variables d'environnement

### Frontend (`.env.local`)

| Variable | Description | Exemple |
|----------|-------------|---------|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Clé API Firebase Web | `AIzaSy...` |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Domaine d'authentification Firebase | `mon-projet.firebaseapp.com` |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | ID du projet Firebase | `radia-prod` |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | Bucket Firebase Storage | `radia-prod.appspot.com` |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | ID expéditeur FCM | `123456789` |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | ID de l'application Firebase | `1:123:web:abc` |
| `NEXT_PUBLIC_USE_EMULATOR` | Activer les émulateurs locaux | `true` / `false` |

### Cloud Functions (secrets Firebase Secret Manager)

| Secret | Description |
|--------|-------------|
| `OPENAI_API_KEY` | Clé API OpenAI pour Whisper |
| `HUGGINGFACE_API_KEY` | Clé API Hugging Face (DrBERT, RadPhi-3) |
| `GEMINI_API_KEY` | Clé API Google AI Studio pour Gemini |

---

## Licence

MIT © 2024 RadIA Contributors

Ce logiciel est fourni à des fins de recherche et de développement. Il ne constitue **pas** un dispositif médical certifié et ne doit pas être utilisé comme seul outil de diagnostic. Toute utilisation clinique nécessite une validation par un radiologue qualifié.
