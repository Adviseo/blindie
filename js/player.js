// Player logic — runs on the phone. Only reads room state, submits answers,
// and never sees the previewUrl (audio is host-only).

import { ensureAnonAuth } from './firebase.js';
import {
  joinRoom, leaveRoom, listenRoom, listenPlayers,
  submitAnswer, roomExists, touchPlayer,
} from './room.js';
import { doc, getDoc, query, where, limit, getDocs, collection } from
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from './firebase.js';
import { escapeHtml, formatArtists } from './utils.js';
import { appConfig } from './config.js';

const $ = id => document.getElementById(id);

const states = ['join', 'lobby', 'playing', 'reveal', 'finished'];
function showState(name) {
  states.forEach(s => $(`state-${s}`).classList.toggle('hidden', s !== name));
}

// === State ===
const state = {
  uid: null,
  roomId: null,
  name: null,
  currentRoundIndex: -1,
  hasSubmittedThisRound: false,
  // Local copy of the current track. Includes title/artists (used to score
  // the answer on submit) and previewUrl (used if the player opts to play
  // audio on their own device via the "Jouer le son ici" button).
  currentTrackPublic: null,
  timerInterval: null,
  // Audio joué localement par le joueur (optionnel — opt-in via bouton).
  localAudio: null,
  localAudioOn: false,
  roundStartedAtMs: null,
  roundDurationMs: null,
};

// === Init ===
(async function init() {
  const user = await ensureAnonAuth();
  state.uid = user.uid;

  // Recover session if any
  const urlParams = new URLSearchParams(window.location.search);
  const roomFromUrl = urlParams.get('code');
  const roomFromSession = sessionStorage.getItem('blindie.roomCode');
  const nameFromSession = sessionStorage.getItem('blindie.playerName');

  if (roomFromUrl && (!roomFromSession || roomFromSession !== roomFromUrl)) {
    // Came through a fresh shared URL: ask for pseudo
    return askForJoin(roomFromUrl);
  }
  if (!roomFromSession || !nameFromSession) {
    return askForJoin(roomFromUrl);
  }

  state.roomId = roomFromSession;
  state.name = nameFromSession;
  $('room-tag').textContent = state.roomId;
  $('me-name').textContent = state.name;
  attachListeners();
})();

function askForJoin(prefillCode) {
  showState('join');
  if (prefillCode) $('join-code-in').value = prefillCode.toUpperCase().slice(0, 4);
  $('join-name-in').value = localStorage.getItem('blindie.lastName') || '';

  $('join-code-in').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  $('btn-join').addEventListener('click', async () => {
    const code = $('join-code-in').value.trim();
    const name = $('join-name-in').value.trim();
    if (code.length !== 4) return showJoinError("Code à 4 caractères.");
    if (!name) return showJoinError("Pseudo manquant.");
    try {
      const ok = await roomExists(code);
      if (!ok) return showJoinError("Aucune partie avec ce code.");
      await joinRoom(code, state.uid, name);
      state.roomId = code;
      state.name = name;
      sessionStorage.setItem('blindie.roomCode', code);
      sessionStorage.setItem('blindie.playerName', name);
      localStorage.setItem('blindie.lastName', name);
      $('room-tag').textContent = code;
      $('me-name').textContent = name;
      attachListeners();
    } catch (e) {
      console.error(e);
      showJoinError(e.message || "Erreur de connexion.");
    }
  });
}

function showJoinError(msg) {
  const el = $('join-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// === Listeners ===
function attachListeners() {
  listenRoom(state.roomId, async room => {
    if (!room) {
      alert("La partie a été fermée.");
      sessionStorage.clear();
      window.location.href = './index.html';
      return;
    }
    await handleRoomUpdate(room);
  });
  listenPlayers(state.roomId, players => {
    renderLobbyPlayers(players);
    renderScoreboard(players);
  });
  // Keep our lastSeen fresh
  setInterval(() => touchPlayer(state.roomId, state.uid), 25_000);
}

async function handleRoomUpdate(room) {
  switch (room.status) {
    case 'lobby':
      stopTimer();
      stopLocalAudio();
      showState('lobby');
      break;

    case 'playing':
      showState('playing');
      // Cache timing info so the local audio button can sync to host
      state.roundStartedAtMs = room.currentRoundStartedAt?.toMillis?.() || null;
      state.roundDurationMs = (room.settings?.roundDurationSeconds
                               || appConfig.defaultRoundDurationSeconds) * 1000;
      if (room.currentRoundIndex !== state.currentRoundIndex) {
        state.currentRoundIndex = room.currentRoundIndex;
        state.hasSubmittedThisRound = false;
        state.currentTrackPublic = null;
        resetAnswerForm();
        stopLocalAudio();
        // Fetch the current track. previewUrl is also fetched but only used
        // if the player opts in via the "Jouer le son ici" button.
        state.currentTrackPublic = await fetchCurrentTrackPublic(room);
        // If the player had enabled local audio earlier, auto-restart on new round
        if (state.localAudioOn) playLocalAudio();
        startPlayerTimer(room);
      } else {
        startPlayerTimer(room);
      }
      $('play-round').textContent = room.currentRoundIndex + 1;
      break;

    case 'reveal':
      stopTimer();
      stopLocalAudio();
      showState('reveal');
      await renderReveal(room);
      break;

    case 'finished':
      stopTimer();
      stopLocalAudio();
      showState('finished');
      $('final-scoreboard').innerHTML = $('scoreboard').innerHTML;
      break;
  }
}

// Fetch the current track from Firestore by `order` field. We pull only
// the metadata fields needed for scoring on submit. The previewUrl is also
// fetched (Firestore doesn't let us select subsets cheaply) but we never
// surface it in the DOM.
async function fetchCurrentTrackPublic(room) {
  if (room.currentRoundIndex == null) return null;
  const q = query(
    collection(db, 'rooms', state.roomId, 'tracks'),
    where('order', '==', room.currentRoundIndex),
    limit(1)
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}

// === Lobby render ===
function renderLobbyPlayers(players) {
  const others = players.filter(p => p.id !== state.uid);
  $('player-count').textContent = players.length;
  $('lobby-players').innerHTML = others.length
    ? others.map(p => `<div class="player-chip"><span class="name">${escapeHtml(p.name)}</span></div>`).join('')
    : '<p class="muted">Encore personne d\'autre…</p>';
}

// === Scoreboard render ===
function renderScoreboard(players) {
  const sorted = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));
  $('scoreboard').innerHTML = sorted.map((p, i) => `
    <div class="score-row rank-${i + 1}">
      <span class="rank">${medal(i)}</span>
      <span class="name">${escapeHtml(p.name)}${p.id === state.uid ? ' (toi)' : ''}</span>
      <span class="pts">${p.score || 0}</span>
    </div>
  `).join('');
}

function medal(i) { return i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`; }

// === Submit answer ===
$('btn-submit').addEventListener('click', async () => {
  if (!state.currentTrackPublic) {
    showJoinError("Round non encore chargé, attends 1s.");
    return;
  }
  const title = $('answer-title').value.trim();
  const artist = $('answer-artist').value.trim();
  if (!title && !artist) {
    flashFeedback("Au moins un des deux champs.", true);
    return;
  }
  $('btn-submit').disabled = true;
  $('btn-submit').textContent = '✓ Envoyé !';
  try {
    await submitAnswer(
      state.roomId, state.uid, state.name,
      state.currentRoundIndex, state.currentTrackPublic,
      { titleAnswer: title, artistAnswer: artist }
    );
    state.hasSubmittedThisRound = true;
    $('submit-feedback').classList.remove('hidden');
    $('submit-feedback').textContent = '✓ Réponse envoyée — tu peux modifier jusqu\'à la révélation';
    // Allow re-submission
    setTimeout(() => {
      $('btn-submit').disabled = false;
      $('btn-submit').textContent = '↻ Modifier ma réponse';
    }, 800);
  } catch (e) {
    console.error(e);
    flashFeedback(e.message, true);
    $('btn-submit').disabled = false;
  }
});

['answer-title', 'answer-artist'].forEach(id => {
  $(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('btn-submit').click(); }
  });
});

function flashFeedback(msg, isError) {
  const el = $('submit-feedback');
  el.textContent = msg;
  el.style.background = isError ? 'rgba(255,51,85,0.15)' : '';
  el.style.borderColor = isError ? 'var(--danger)' : '';
  el.style.color = isError ? '#ffb3c0' : '';
  el.classList.remove('hidden');
}

function resetAnswerForm() {
  $('answer-title').value = '';
  $('answer-artist').value = '';
  $('submit-feedback').classList.add('hidden');
  $('btn-submit').disabled = false;
  $('btn-submit').textContent = '🚨 ENVOYER';
}

// === Timer (synced from server timestamp) ===
function startPlayerTimer(room) {
  stopTimer();
  const startedAt = room.currentRoundStartedAt?.toMillis?.();
  if (!startedAt) return;
  const duration = (room.settings?.roundDurationSeconds || appConfig.defaultRoundDurationSeconds) * 1000;
  const update = () => {
    const remaining = Math.max(0, Math.round((startedAt + duration - Date.now()) / 1000));
    $('play-timer').textContent = remaining;
    $('play-timer').classList.toggle('danger', remaining <= 5 && remaining > 0);
    if (remaining <= 0) stopTimer();
  };
  update();
  state.timerInterval = setInterval(update, 500);
}
function stopTimer() {
  clearInterval(state.timerInterval);
  state.timerInterval = null;
}

// === Reveal ===
async function renderReveal(room) {
  let track = state.currentTrackPublic;
  if (!track || track.id !== room.revealedTrackId) {
    if (room.revealedTrackId) {
      const ref = doc(db, 'rooms', state.roomId, 'tracks', room.revealedTrackId);
      const snap = await getDoc(ref);
      if (snap.exists()) track = { id: snap.id, ...snap.data() };
    }
  }
  if (!track) return;

  $('reveal-title').textContent = track.title;
  $('reveal-artist').textContent = formatArtists(track.artists);
  const art = $('reveal-art');
  art.innerHTML = track.imageUrl ? `<img src="${track.imageUrl}" alt="">` : '🎵';

  // My result this round
  const myAnsRef = await findMyAnswerForRound(room.currentRoundIndex);
  const result = $('my-points');
  if (myAnsRef) {
    const pts = myAnsRef.totalScore || 0;
    if (pts >= 2) {
      result.textContent = `✓✓ +${pts} pts`;
      result.style.background = 'rgba(57,255,20,0.25)';
      result.style.color = 'var(--neon-green)';
    } else if (pts === 1) {
      result.textContent = `± +1 pt`;
      result.style.background = 'rgba(255,214,10,0.25)';
      result.style.color = 'var(--neon-yellow)';
    } else {
      result.textContent = '✗ Raté';
      result.style.background = 'rgba(255,51,85,0.25)';
      result.style.color = 'var(--danger)';
    }
  } else {
    result.textContent = '— Pas de réponse —';
    result.style.background = 'rgba(184,168,212,0.15)';
    result.style.color = 'var(--text-dim)';
  }
}

async function findMyAnswerForRound(roundIndex) {
  const q = query(
    collection(db, 'rooms', state.roomId, 'answers'),
    where('playerId', '==', state.uid),
    where('roundIndex', '==', roundIndex),
    limit(1)
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  return snap.docs[0].data();
}

// === Leave ===
$('btn-leave').addEventListener('click', async () => {
  if (!confirm("Quitter la partie ?")) return;
  await leaveRoom(state.roomId, state.uid).catch(() => {});
  sessionStorage.clear();
  window.location.href = './index.html';
});

// === Local audio (opt-in per round, persists toggle across rounds) ===
// L'audio joué localement utilise le previewUrl iTunes déjà stocké dans
// Firestore. On synchronise au mieux avec le host en seekant en fonction
// de l'écart entre `currentRoundStartedAt` (timestamp serveur) et maintenant.
$('btn-local-audio').addEventListener('click', () => {
  if (state.localAudioOn) {
    stopLocalAudio();
    state.localAudioOn = false;
    updateLocalAudioBtn();
  } else {
    state.localAudioOn = true;
    playLocalAudio();
    updateLocalAudioBtn();
  }
});

function playLocalAudio() {
  const track = state.currentTrackPublic;
  if (!track?.previewUrl) return;

  if (!state.localAudio) state.localAudio = $('local-audio');
  state.localAudio.src = track.previewUrl;
  state.localAudio.volume = 1;

  // Seek to the elapsed point relative to the host's round start.
  // iTunes previews durent 30s. Si l'écart est trop grand, on ne joue pas.
  const elapsed = state.roundStartedAtMs
    ? (Date.now() - state.roundStartedAtMs) / 1000
    : 0;
  if (elapsed >= 30) return;  // preview déjà terminé
  state.localAudio.currentTime = Math.max(0, elapsed);
  state.localAudio.play().catch(err => {
    console.warn('Audio bloqué :', err);
  });
}

function stopLocalAudio() {
  if (state.localAudio) {
    state.localAudio.pause();
    state.localAudio.currentTime = 0;
  }
}

function updateLocalAudioBtn() {
  const btn = $('btn-local-audio');
  if (state.localAudioOn) {
    btn.textContent = '🔇 Couper le son ici';
    btn.classList.remove('btn-secondary');
    btn.classList.add('btn-ghost');
  } else {
    btn.textContent = '🔊 Jouer le son ici';
    btn.classList.add('btn-secondary');
    btn.classList.remove('btn-ghost');
  }
}
