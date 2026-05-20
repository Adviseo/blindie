// Firebase init: Firestore + Anonymous Auth.
// We use the modular SDK loaded from gstatic so the app stays build-free.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from './config.js';

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// Re-export the few Firestore helpers everyone needs, so other modules
// don't have to remember the long gstatic URL.
export { serverTimestamp, Timestamp };

// === Anonymous auth ===
// Resolves with the Firebase user object (with a stable uid). Used as
// hostId / playerId in the Firestore data model.
let _authPromise = null;
export function ensureAnonAuth() {
  if (_authPromise) return _authPromise;
  _authPromise = new Promise((resolve, reject) => {
    onAuthStateChanged(auth, user => {
      if (user) return resolve(user);
      signInAnonymously(auth).catch(reject);
    });
  });
  return _authPromise;
}

export function currentUid() {
  return auth.currentUser?.uid || null;
}
