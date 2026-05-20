// === BLINDIE — Configuration ===
// Toute la config statique se trouve dans CE fichier.
// Voir README.md pour le détail des étapes Firebase / Spotify / GitHub Pages.

// --- Firebase (clés publiques, sécurisées par les règles Firestore) ---
export const firebaseConfig = {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME.firebaseapp.com",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME.appspot.com",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME",
};

// --- Spotify (OAuth 2.0 PKCE — pas de client secret) ---
// Le redirectUri DOIT matcher EXACTEMENT celui enregistré dans le dashboard
// Spotify Developer (incluant le https, le chemin, l'absence ou présence de
// trailing slash).
export const spotifyConfig = {
  clientId: "REPLACE_ME",
  redirectUri: "https://TON_USER.github.io/TON_REPO/host.html",
  scopes: [
    "playlist-read-private",
    "playlist-read-collaborative",
  ].join(" "),
};

// --- App ---
export const appConfig = {
  baseUrl: "https://TON_USER.github.io/TON_REPO",
  defaultRoundDurationSeconds: 30,
  pointsTitle: 1,
  pointsArtist: 1,
  maxRoundsPerGame: 20,
  // Seuil de confiance minimum pour accepter un match iTunes
  // (0..1). Au-dessus, on prend le previewUrl du résultat.
  previewMatchThreshold: 0.65,
};

// --- Auto-détection pour le dev local ---
// Quand on ouvre l'app sur 127.0.0.1 / localhost (Live Server, npx serve…),
// on bascule automatiquement les URLs en local. Pratique pour développer
// sans avoir à modifier ce fichier à chaque déploiement.
const isLocalhost = typeof window !== 'undefined' &&
  /^(127\.0\.0\.1|localhost|\[::1\])$/.test(window.location.hostname);

if (isLocalhost) {
  const local = window.location.origin;
  spotifyConfig.redirectUri = `${local}/host.html`;
  appConfig.baseUrl = local;
}
