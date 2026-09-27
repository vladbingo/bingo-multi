# ♛ Bingo Royal — Plateforme multijoueur en ligne

Jeu de bingo **multijoueur en temps réel** : jusqu'à **100 joueurs par partie**, chacun sur son téléphone. L'organisateur crée une partie, partage le code à 6 lettres, et tout le monde joue en même temps.

## ✨ Fonctionnalités

- **Temps réel** (WebSocket) : tirages synchronisés pour tous les joueurs
- **Jusqu'à 100 joueurs** par partie, chacun sur son téléphone
- **🔑 Panneau administrateur** : le créateur définit un mot de passe admin et pilote tout depuis le salon :
  - **cagnottes par palier** (1 ligne, 2 lignes, 3 lignes, 4 lignes, carte pleine)
  - nom de la partie, cartes max par joueur (1–25), vitesse, tirage auto/manuel
  - **exclure un joueur**, voir les joueurs et leurs cartes, **historique des manches**
  - reconnexion admin depuis n'importe quel appareil avec le mot de passe
- **Cartes générées côté serveur** → les victoires sont vérifiées par le serveur (anti-triche)
- **5 paliers progressifs** (style vrai bingo de salle) : 1 ligne → 2 lignes → 3 lignes → 4 lignes → carte pleine. Chaque palier remporté fait **continuer** la partie
- **1 à 25 cartes par joueur** (choix perso à l'inscription), case centrale gratuite
- Tirage **automatique** (lent 8 s / normal 5 s / rapide 3 s) ou **manuel**, avec pause/reprise
- Compte à rebours synchronisé, historique des boules, tableau des 75 numéros
- **Premier à crier BINGO gagne** (timestamp serveur en cas d'égalité)
- Migration automatique de l'hôte s'il quitte, spectateurs en cours de partie
- Design **casino premium** (or, feutrine, boules 3D), confettis, sons WebAudio, 100 % mobile

## 🚀 Lancer en local

```bash
cd bingo-multi
npm install
node server.js
```

Puis ouvre http://localhost:3000 sur ton téléphone (même Wi-Fi que l'ordi).

Pour tester : `npm test` (53 tests automatisés : création, admin/connexion/kick, configuration, paliers, limite 100 joueurs, migration d'hôte, spectateurs).

## ☁️ Mettre en ligne sur Render (gratuit, 1 clic)

**Option A — bouton Deploy :**
1. Mets ce dossier sur GitHub
2. Va sur https://render.com → *New* → *Blueprint* → colle l'URL de ton dépôt
3. Render détecte `render.yaml` et déploie tout seul

**Option B — manuel :**
1. https://render.com → *New* → *Web Service* → connecte ton dépôt GitHub
2. *Build Command* : `npm install` · *Start Command* : `node server.js`
3. Plan **Free**, puis *Deploy*

Render fournit automatiquement le **HTTPS** — les WebSockets passent en `wss://` sans rien configurer (le client utilise une URL relative).

## 📱 Comment jouer

1. **L'hôte** ouvre l'URL sur son téléphone → entre son pseudo → **« Créer une partie »**
2. Il partage le **code à 6 caractères** (bouton copier) aux autres joueurs
3. Chaque joueur ouvre la **même URL** sur son téléphone → entre son pseudo + le code → **« Rejoindre »**
4. L'hôte règle les paramètres (vitesse, tirage auto/manuel) et **lance la partie**
5. Les boules tombent en direct — dès qu'une carte complète un palier, son bouton **🎉 BINGO** s'illumine : on appuie pour réclamer le palier (le premier à réclamer gagne, la partie continue jusqu'à la carte pleine)

> Astuce : pas besoin d'installer quoi que ce soit. Sur iPhone : *Partager* → *Sur l'écran d'accueil* pour l'ouvrir comme une vraie app.
