# Changelog

Chaque changement de l'application incrémente la version dans `package.json` (affichée en bas de la barre latérale).

- **Correctif** → `0.2.x`
- **Nouvelle fonctionnalité** → `0.x.0`

## 0.2.1

- Correctif : la version s'affiche bien en bas de la barre latérale (elle était écrite au mauvais endroit).
- Logs : erreurs de statut de la machine, nombre de conversations chargées au démarrage, suppressions de conversations.

## 0.2.0

- Défilement automatique du chat qui se coupe quand on remonte pour relire, et reprend en bas.
- Boutons Copier, Modifier et Régénérer sous les messages.
- Anti-boucle : réglages anti-répétition de Qwen3, limite de longueur, arrêt automatique si le modèle se répète.
- Réflexion qui défile en direct.
- Pod : flash attention et cache KV en q8_0, le modèle 32B tient entier dans le GPU (~35 tokens/s).
- Journal des erreurs (`logs/rankicode.log`), bouton « Ouvrir les logs », F12.
- Conversation enregistrée dès l'envoi, réponse conservée en changeant de conversation.
- Rendu Markdown (tableaux, code, listes), bouton Stop.
- Pilotage de Firefox (par défaut) ou Chrome par l'agent.
- Recréation automatique du pod quand les GPU sont pris.
- Onglets Monitoring et Terminal du pod.
- Pièces jointes : texte, Excel, images.
- Mode Agent (commandes PowerShell validées) et mode Auto.

## 0.1.0

- Première version : chat Ollama, historique local, allumer/éteindre un pod RunPod.
