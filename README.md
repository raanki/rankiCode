# RankiCode

Application de bureau (Electron) pour discuter avec un modèle Ollama hébergé sur un pod RunPod — ou en local — avec une interface minimaliste façon Claude.

## Fonctionnalités

- **Chat** avec réponses en streaming et réflexion du modèle visible en direct.
- **Historique local** : les conversations sont enregistrées sur le PC, elles survivent à l'extinction du pod.
- **Allumer / éteindre le pod** RunPod en un clic, coût horaire affiché. Si les GPU de la machine ont été loués entre-temps, le pod est recréé automatiquement ailleurs.
- **Plusieurs machines / modèles** configurables (RunPod, Ollama local…).
- **Pièces jointes** : texte, code, CSV, Excel (converti en tableau), images (pour les modèles vision).
- **Mode Agent** : le modèle exécute des commandes PowerShell sur le PC, chacune validée par l'utilisateur. Mode **Auto** optionnel sans validation.
- **Pilotage du navigateur** (Firefox par défaut, ou Chrome) : ouvrir une page, lire, cliquer, taper, capture d'écran. Profil de navigateur dédié, séparé du profil personnel.
- **Monitoring** du pod (GPU, VRAM, CPU, RAM, coût de la session) et **terminal** du pod intégré.

## Installation

```bash
npm install
npm start
```

Prérequis : Node.js 20+, Windows (le mode agent utilise PowerShell).

## Configuration

Au premier lancement, ouvrez **Réglages** :

1. Collez votre clé API RunPod.
2. Dans le JSON des machines, remplacez `VOTRE_POD_ID` par l'identifiant de votre pod.

La configuration (clé API, mots de passe) et l'historique sont stockés dans le dossier de données de l'application (`%APPDATA%\rankicode`), jamais dans ce dépôt.

### Pod RunPod attendu

- Image `ollama/ollama:latest`, ports `11434/http` (API Ollama) et `7681/http` (terminal web).
- Variable `TTYD_PASS` : mot de passe du terminal, à reporter dans `terminalPass` de la machine.
- La recette complète (commande de démarrage) est dans `POD_SPEC` de `main.js`.

## Sécurité

- Le mode **Auto** laisse le modèle exécuter des commandes et naviguer sans validation : à n'utiliser qu'en connaissance de cause.
- L'API Ollama exposée via le proxy RunPod n'a pas d'authentification : ne partagez pas l'URL de votre pod.
