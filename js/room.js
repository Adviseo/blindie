// Room + game logic on top of Firestore.
// All multi-device sync happens here: rooms, tracks, players, answers.

import {
  doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc,
  collection, query, where, orderBy, limit, getDocs,
  onSnapshot, writeBatch, increment, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, ensureAnonAuth } from './firebase.js';
import { generateJoinCode, scoreMatch, normalizeText } from './utils.js';
import { appConfig } from './config.js';

// ===================================================================
// Path helpers
// ===================================================================
const roomDoc = (roomId) => doc(db, 'rooms', roomId);
const tracksCol = (roomId) => collection(db, 'rooms', roomId, 'tracks');
const trackDoc = (roomId, trackId) => doc(db, 'rooms', roomId, 'tracks', trackId);
const playersCol = (roomId) => collection(db, 'rooms', roomId, 'players');
const playerDoc = (roomId, playerId) => doc(db, 'rooms', roomId, 'players', playerId);
const answersCol = (roomId) => collection(db, 'rooms', roomId, 'answers');

// ===================================================================
// Room creation / lookup
// ===================================================================

// Creates a new room owned by hostId. Picks a 4-char joinCode that is also
// used as the document ID (collisions are retried).
export async function createRoom(hostId) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateJoinCode(4);
    const ref = roomDoc(code);
    const snap = await getDoc(ref);
    if (snap.exists()) continue;
    await setDoc(ref, {
      roomId: code,
      joinCode: code,
      hostId,
      status: 'lobby',
      currentRoundIndex: -1,
      currentRoundStartedAt: null,
      revealedTrackId: null,
      createdAt: serverTimestamp(),
      settings: {
        roundDurationSeconds: appConfig.defaultRoundDurationSeconds,
        pointsTitle: appConfig.pointsTitle,
        pointsArtist: appConfig.pointsArtist,
      },
    });
    return { roomId: code, joinCode: code };
  }
  throw new Error("Impossible de générer un code unique, réessaie.");
}

export async function getRoom(roomId) {
  const snap = await getDoc(roomDoc(roomId));
  return snap.exists() ? snap.data() : null;
}

export async function roomExists(roomId) {
  const snap = await getDoc(roomDoc(roomId));
  return snap.exists();
}

// ===================================================================
// Tracks
// ===================================================================

// Add the enriched tracks (from previews.enrichTracksWithPreviews) to the
// room's tracks subcollection. Only `playable: true` tracks are added —
// the rest are dropped so the round flow stays simple.
export async function addTracksToRoom(roomId, tracks) {
  const playable = tracks.filter(t => t.playable);
  const batch = writeBatch(db);
  playable.forEach((t, idx) => {
    const ref = doc(tracksCol(roomId));
    batch.set(ref, { ...t, order: idx });
  });
  // Also record the total count on the room doc for convenience.
  batch.update(roomDoc(roomId), { totalRounds: playable.length });
  await batch.commit();
  return playable.length;
}

// Fetch all tracks ordered by `order` (host-side use only — players never
// query this collection so they don't see the previewUrl).
export async function fetchRoomTracks(roomId) {
  const q = query(tracksCol(roomId), orderBy('order', 'asc'));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function fetchTrackByOrder(roomId, order) {
  const q = query(tracksCol(roomId), where('order', '==', order), limit(1));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}

// ===================================================================
// Players
// ===================================================================

// A joining player creates their own player doc using their Firebase Auth
// uid (so listenRoom can identify them later).
export async function joinRoom(roomId, playerId, playerName) {
  await setDoc(playerDoc(roomId, playerId), {
    name: playerName,
    joinedAt: serverTimestamp(),
    score: 0,
    lastSeen: serverTimestamp(),
  }, { merge: true });
}

export async function leaveRoom(roomId, playerId) {
  await deleteDoc(playerDoc(roomId, playerId)).catch(() => {});
}

export async function updatePlayerScore(roomId, playerId, points) {
  if (!points) return;
  await updateDoc(playerDoc(roomId, playerId), { score: increment(points) });
}

export async function touchPlayer(roomId, playerId) {
  await updateDoc(playerDoc(roomId, playerId), { lastSeen: serverTimestamp() })
    .catch(() => {});
}

// ===================================================================
// Listeners
// ===================================================================

export function listenRoom(roomId, callback) {
  return onSnapshot(roomDoc(roomId), snap => {
    callback(snap.exists() ? snap.data() : null);
  });
}

export function listenPlayers(roomId, callback) {
  const q = query(playersCol(roomId), orderBy('joinedAt', 'asc'));
  return onSnapshot(q, snap => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

export function listenAnswers(roomId, roundIndex, callback) {
  const q = query(answersCol(roomId), where('roundIndex', '==', roundIndex));
  return onSnapshot(q, snap => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

// ===================================================================
// Game flow
// ===================================================================

export async function startGame(roomId) {
  await startRound(roomId, 0);
}

export async function startRound(roomId, roundIndex) {
  await updateDoc(roomDoc(roomId), {
    status: 'playing',
    currentRoundIndex: roundIndex,
    currentRoundStartedAt: serverTimestamp(),
    revealedTrackId: null,
  });
}

export async function revealRound(roomId, trackId) {
  await updateDoc(roomDoc(roomId), {
    status: 'reveal',
    revealedTrackId: trackId,
  });
}

export async function nextRound(roomId, newIndex) {
  await startRound(roomId, newIndex);
}

export async function endGame(roomId) {
  await updateDoc(roomDoc(roomId), { status: 'finished' });
}

// ===================================================================
// Answers + scoring
// ===================================================================

// Scoring is computed on submit (fuzzy match against the track's title and
// artists). Players see "answer sent" until reveal time, when the host UI
// reveals the right answer and the per-player breakdown.
export function calculateScore(answer, track, settings) {
  const pointsTitle = settings?.pointsTitle ?? appConfig.pointsTitle;
  const pointsArtist = settings?.pointsArtist ?? appConfig.pointsArtist;
  const threshold = 0.75;

  let scoreTitle = 0;
  if (answer.titleAnswer && scoreMatch(track.title, answer.titleAnswer) >= threshold) {
    scoreTitle = pointsTitle;
  }

  let scoreArtist = 0;
  if (answer.artistAnswer && (track.artists || []).length) {
    // Take the best score across all artists (groups often have several).
    const best = Math.max(
      ...track.artists.map(a => scoreMatch(a, answer.artistAnswer))
    );
    if (best >= threshold) scoreArtist = pointsArtist;
  }
  return { scoreTitle, scoreArtist, totalScore: scoreTitle + scoreArtist };
}

// Submit a player's answer for the current round. Computes the score
// immediately, persists it, and bumps the player's cumulative score.
//
// Re-submission: if the player already submitted for this round, we
// REPLACE their previous answer and adjust the cumulative score by the
// delta — so they can change their mind until reveal without double-counting.
export async function submitAnswer(roomId, playerId, playerName, roundIndex, track, answer) {
  const room = await getRoom(roomId);
  if (!room) throw new Error("Room introuvable.");
  if (room.status !== 'playing') throw new Error("Tu ne peux plus répondre pour ce round.");
  if (room.currentRoundIndex !== roundIndex) throw new Error("Round désynchronisé.");

  const scoreParts = calculateScore(answer, track, room.settings);

  // Look up any existing answer for this player + round.
  const q = query(
    answersCol(roomId),
    where('playerId', '==', playerId),
    where('roundIndex', '==', roundIndex),
    limit(1)
  );
  const existing = await getDocs(q);

  const payload = {
    playerId,
    playerName,
    roundIndex,
    titleAnswer: (answer.titleAnswer || '').trim(),
    artistAnswer: (answer.artistAnswer || '').trim(),
    submittedAt: serverTimestamp(),
    scoreTitle: scoreParts.scoreTitle,
    scoreArtist: scoreParts.scoreArtist,
    totalScore: scoreParts.totalScore,
  };

  if (existing.empty) {
    await addDoc(answersCol(roomId), payload);
    await updatePlayerScore(roomId, playerId, scoreParts.totalScore);
  } else {
    const ref = existing.docs[0].ref;
    const prev = existing.docs[0].data();
    await setDoc(ref, payload, { merge: false });
    const delta = scoreParts.totalScore - (prev.totalScore || 0);
    if (delta !== 0) await updatePlayerScore(roomId, playerId, delta);
  }
  return scoreParts;
}

// ===================================================================
// Cleanup
// ===================================================================

// Delete a room and all its subcollections (tracks, players, answers).
// Used when the host bails out. Best-effort.
export async function deleteRoom(roomId) {
  const subs = ['tracks', 'players', 'answers'];
  for (const sub of subs) {
    const snap = await getDocs(collection(db, 'rooms', roomId, sub));
    const batch = writeBatch(db);
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit().catch(() => {});
  }
  await deleteDoc(roomDoc(roomId)).catch(() => {});
}

// Re-export for convenience
export { ensureAnonAuth };
