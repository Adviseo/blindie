# BLINDIE

Web app privée de blind test entre potes. **Stack 100 % statique** (HTML/CSS/JS vanilla, ES modules) déployable sur GitHub Pages. **Aucun serveur backend.**

- L'host se connecte à Spotify pour importer une **playlist** (uniquement les métadonnées : titre, artiste, pochette).
- L'app cherche un **extrait audio de 30 s sur iTunes** (Apple Search API) pour chaque morceau. Aucune dépendance à Spotify Premium ou au Web Playback SDK.
- Les joueurs rejoignent via un **code à 4 caractères** depuis leur téléphone.
- L'audio est joué **uniquement côté host** (TV/PC).
- Le scoring est automatique avec **matching tolérant** (accents, ponctuation, "feat. / remastered", etc.).
- Le temps réel est géré par **Firebase Firestore** (+ Auth anonyme).

---

## Sommaire

1. [Configuration Firebase](#1-configuration-firebase)
2. [Configuration Spotify Developer](#2-configuration-spotify-developer)
3. [Configuration GitHub Pages](#3-configuration-github-pages)
4. [Exemple `js/config.js`](#4-exemple-jsconfigjs)
5. [Règles Firestore de développement](#5-règles-firestore-de-développement)
6. [Lancer en local](#6-lancer-en-local)
7. [Architecture des fichiers](#7-architecture-des-fichiers)
8. [Limites connues](#8-limites-connues)
9. [Plan d'amélioration](#9-plan-damélioration)

---

## 1. Configuration Firebase

1. Va sur https://console.firebase.google.com → **Add project** → nom : `Blindie` (Analytics non requis).
2. Dans le projet : **Build → Firestore Database → Create database**
   - Location : `europe-west1` (Belgique) ou plus proche
   - Démarre en **Production mode** (on fournira nos règles ci-dessous).
3. **Build → Authentication → Get started → Sign-in method → Anonymous → Enable**.
4. **Project Settings → General → Your apps → Web (`</>`)** → enregistre l'app "Blindie Web" → copie l'objet `firebaseConfig` qui apparaît.
5. Colle-le dans [`js/config.js`](js/config.js) (bloc `firebaseConfig`).

Les clés Firebase sont **publiques** par nature côté web : la sécurité repose entièrement sur les règles Firestore + Auth.

---

## 2. Configuration Spotify Developer

1. Va sur https://developer.spotify.com/dashboard (connexion avec ton compte Spotify perso).
2. **Create app**
   - Name : `Blindie`
   - Description : `Blind test privé entre potes`
   - **APIs used** : coche **Web API** (ne PAS cocher Web Playback SDK).
   - **Redirect URIs** : ajoute les deux suivantes (sans trailing slash) :
     - `http://127.0.0.1:5500/host.html` (dev local)
     - `https://TON_USER.github.io/TON_REPO/host.html` (prod GitHub Pages)
3. Save → copie le **Client ID** (pas besoin du secret, on utilise PKCE).
4. Colle-le dans [`js/config.js`](js/config.js) (bloc `spotifyConfig.clientId`) et adapte `spotifyConfig.redirectUri` à ton URL GitHub Pages.

⚠ **Mode "Development"** : par défaut, ton app Spotify est privée. Tu peux ajouter jusqu'à **25 utilisateurs Spotify** dans **User Management**. Pour BLINDIE, seul l'host se connecte à Spotify donc 1 slot suffit (toi).

---

## 3. Configuration GitHub Pages

1. Push le repo sur GitHub (voir [Commandes Git](#commandes-git)).
2. Repo settings : **Settings → Pages → Source → Deploy from a branch**
3. Branch : **`main`** · Folder : **`/ (root)`** · **Save**.
4. Attends 30-60 s, ton app sera disponible sur :
   `https://TON_USER.github.io/TON_REPO/`
5. **Mets cette URL exacte** dans :
   - `spotifyConfig.redirectUri` de `js/config.js`
   - les **Redirect URIs** du dashboard Spotify

Si tu utilises un repo nommé `TON_USER.github.io` (site utilisateur), l'URL est sans préfixe : `https://TON_USER.github.io/`.

---

## 4. Exemple `js/config.js`

```js
export const firebaseConfig = {
  apiKey: "AIzaSyA...",
  authDomain: "blindie-12345.firebaseapp.com",
  projectId: "blindie-12345",
  storageBucket: "blindie-12345.appspot.com",
  messagingSenderId: "987654321",
  appId: "1:987654321:web:abc123"
};

export const spotifyConfig = {
  clientId: "abcdef0123456789abcdef0123456789",
  redirectUri: "https://chrispernold.github.io/blindie/host.html",
  scopes: [
    "playlist-read-private",
    "playlist-read-collaborative",
  ].join(" "),
};

export const appConfig = {
  baseUrl: "https://chrispernold.github.io/blindie",
  defaultRoundDurationSeconds: 30,
  pointsTitle: 1,
  pointsArtist: 1,
  maxRoundsPerGame: 20,
  previewMatchThreshold: 0.65,
};
```

> **Astuce :** quand l'app détecte un hostname `127.0.0.1` ou `localhost`, elle bascule automatiquement `redirectUri` et `baseUrl` sur l'URL locale. Tu n'as pas besoin de modifier ce fichier pour développer.

---

## 5. Règles Firestore de développement

Dans **Firestore → Rules**, colle ceci. C'est suffisant pour un usage privé entre amis (toute personne authentifiée — donc tout visiteur anonyme — peut lire/écrire dans n'importe quelle room) :

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
                    && request.resource.data.hostId == request.auth.uid;
      allow update, delete: if request.auth != null;

      match /tracks/{trackId} {
        allow read, write: if request.auth != null;
      }
      match /players/{playerId} {
        allow read: if request.auth != null;
        // Un joueur ne peut écrire que SON propre doc
        allow write: if request.auth != null && request.auth.uid == playerId;
      }
      match /answers/{answerId} {
        allow read: if request.auth != null;
        // Un joueur ne peut écrire qu'une réponse à son nom
        allow create, update: if request.auth != null
                              && request.resource.data.playerId == request.auth.uid;
        allow delete: if request.auth != null;
      }
    }
  }
}
```

Pour aller plus loin : tu pourrais restreindre les updates de `players.score` au seul host, restreindre la création de rooms à un allowlist, etc. — pas indispensable entre potes.

---

## 6. Lancer en local

Spotify exige une redirect URI en `https://...` **ou** sur `127.0.0.1`. Le plus simple est un serveur statique local sur le port `5500`.

**Option A — VS Code Live Server**
1. Installe l'extension "Live Server" (Ritwick Dey).
2. Ouvre `D:\Claude\Blindie` dans VS Code.
3. Clic droit sur `index.html` → **Open with Live Server**.
4. L'app s'ouvre sur `http://127.0.0.1:5500/`.

**Option B — Python**
```bash
python -m http.server 5500 --bind 127.0.0.1
```

**Option C — npx**
```bash
npx serve -l 5500
```

> ⚠ Pour que les téléphones de tes potes accèdent à l'app **en local**, lance le serveur sur `0.0.0.0` (et non `127.0.0.1`), ouvre le port 5500 dans le pare-feu Windows, et donne-leur ton IP locale (`ipconfig`). En vrai c'est plus simple de déployer sur GitHub Pages.

---

## 7. Architecture des fichiers

```
/index.html         Landing page (Créer / Rejoindre)
/host.html          Vue host (PC/TV)
/player.html        Vue joueur (téléphone)
/css/styles.css     Design néon sombre
/js/config.js       ⚠ À REMPLIR (Firebase, Spotify, app)
/js/firebase.js     Init Firebase + Auth anonyme
/js/spotify.js      OAuth PKCE + lecture playlist
/js/previews.js     iTunes Search API (+ stub Deezer)
/js/room.js         Toute la logique de room sur Firestore
/js/utils.js        Normalisation texte + fuzzy match + helpers
/js/host.js         Logique host (flow complet)
/js/player.js       Logique joueur (téléphone)
/README.md          Ce fichier
/.gitignore         Fichiers à exclure du repo
```

### Modèle Firestore

```
rooms/{roomId}
  roomId, joinCode, hostId, status, currentRoundIndex,
  currentRoundStartedAt, revealedTrackId, createdAt,
  settings: { roundDurationSeconds, pointsTitle, pointsArtist },
  totalRounds

rooms/{roomId}/tracks/{trackId}
  order, spotifyId, title, artists[], album, imageUrl,
  previewUrl, source:"itunes", playable,
  normalizedTitle, normalizedArtists[]

rooms/{roomId}/players/{playerId}
  name, joinedAt, score, lastSeen

rooms/{roomId}/answers/{answerId}
  playerId, playerName, roundIndex,
  titleAnswer, artistAnswer, submittedAt,
  scoreTitle, scoreArtist, totalScore
```

---

## Commandes Git

```bash
# 1. Init et premier commit (depuis D:\Claude\Blindie)
git init
git add .
git commit -m "Initial commit: BLINDIE v1"

# 2. Créer le repo GitHub (CLI authentifié requis)
#    privé :
gh repo create blindie --private --source=. --remote=origin --push
#    ou public :
gh repo create blindie --public  --source=. --remote=origin --push

# 3. Activer GitHub Pages
#    Settings → Pages → Deploy from branch → main → root → Save
```

---

## 8. Limites connues

- **Pas anti-triche.** Les `previewUrl` (iTunes) sont stockés dans Firestore. Un joueur curieux qui inspecte la base peut les voir. C'est privé entre amis, pas une compétition publique.
- **Matching iTunes ≠ Spotify.** L'extrait joué peut être une autre version (remaster, live) du même morceau. Pour la grande majorité, c'est imperceptible.
- **Previews iTunes manquantes.** Certains morceaux n'ont pas d'aperçu Apple — ils sont marqués "pas de preview" et exclus du jeu. Les playlists mainstream marchent mieux.
- **Auto-play mobile.** iOS Safari peut refuser de lancer `audio.play()` sans interaction utilisateur. Sur l'host (qui clique pour lancer la partie), aucun souci. Sur les joueurs : on ne joue jamais d'audio, donc OK.
- **Firestore en mode "tout authentifié".** Les règles fournies sont permissives. Acceptable entre amis.
- **CORS Deezer.** Le fallback Deezer est un stub (l'API Deezer bloque CORS). Branchable via un proxy léger si besoin.

---

## 9. Plan d'amélioration

- [ ] Validation manuelle optionnelle par le host (toggle dans les settings)
- [ ] Bonus de rapidité au premier à trouver
- [ ] Playlists pré-configurées (thèmes : années 80, FR, etc.)
- [ ] Choix de la durée du round dans l'UI host
- [ ] Mode "auto-reveal" à la fin du timer
- [ ] Statistiques de partie (rounds les plus difficiles, etc.)
- [ ] PWA installable (offline shell)
- [ ] Deezer fallback via proxy serverless (Cloudflare Worker)
- [ ] Animation de confettis sur bonne réponse
- [ ] Effets sonores host (countdown, reveal)
