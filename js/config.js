// === BLINDIE — Configuration ===
// Toute la config statique se trouve dans CE fichier.
// Voir README.md pour le détail des étapes Firebase / Spotify / GitHub Pages.

// --- Firebase (clés publiques, sécurisées par les règles Firestore) ---
export const firebaseConfig = {
  apiKey: "AIzaSyAs0SatWss5oimh4JcoVaW79jRLIkcq3Zs",
  authDomain: "blindie-app.firebaseapp.com",
  projectId: "blindie-app",
  storageBucket: "blindie-app.firebasestorage.app",
  messagingSenderId: "521213406532",
  appId: "1:521213406532:web:9a96a6173637ee96d53b11",
};

// --- Spotify (OAuth 2.0 PKCE — pas de client secret) ---
// Le redirectUri DOIT matcher EXACTEMENT celui enregistré dans le dashboard
// Spotify Developer (incluant le https, le chemin, l'absence ou présence de
// trailing slash).
export const spotifyConfig = {
  clientId: "27e33cf995d94c8480ffbaf09a019ce4",
  redirectUri: "https://blindie-app.netlify.app/host.html",
  scopes: [
    "playlist-read-private",
    "playlist-read-collaborative",
  ].join(" "),
};

// --- App ---
export const appConfig = {
  baseUrl: "https://blindie-app.netlify.app",
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
