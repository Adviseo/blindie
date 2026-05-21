// Host logic. Drives the whole game from playlist import to final podium.
//
// Flow:
//   login → import playlist (Spotify metadata)
//         → enrich with iTunes previews (per-track progress)
//         → create room (Firestore) → push playable tracks
//         → lobby (watch players join)
//         → for each round: play audio, watch answers, reveal, advance
//         → finished: show podium.

import { ensureAnonAuth } from './firebase.js';
import {
  loginWithSpotify, handleSpotifyCallback, isLoggedIn, logout,
  getCurrentSpotifyUser, parseSpotifyPlaylistUrl,
  fetchSpotifyPlaylistTracks, fetchPlaylistMeta,
} from './spotify.js';
import { enrichTracksWithPreviews } from './previews.js';
import {
  createRoom, addTracksToRoom, fetchRoomTracks,
  startRound, lockRound, revealRound, endGame,
  scoreRound, fetchAnswersForRound,
  listenPlayers, listenAnswers, deleteRoom,
} from './room.js';
import { escapeHtml, formatArtists, safeImageUrl } from './utils.js';
import { appConfig } from './config.js';

const $ = id => document.getElementById(id);

// === Step routing ===
const steps = ['login', 'import', 'lobby', 'playing', 'reveal', 'finished'];
function showStep(name) {
  steps.forEach(s => $(`step-${s}`).classList.toggle('hidden', s !== name));
  $('mini-score').classList.toggle('hidden', !['playing', 'reveal'].includes(name));
  state.step = name;
}

// === State ===
const state = {
  step: null,            // current showStep() name — used by listeners pour
                         // choisir entre renderLiveAnswers / renderRevealAnswers
  hostId: null,
  roomId: null,
  enriched: [],          // results from enrichTracksWithPreviews (incl. ignored)
  tracks: [],            // playable tracks fetched back from Firestore
  roundIndex: 0,
  currentTrack: null,
  timerInterval: null,
  audio: null,
  unsubPlayers: null,
  unsubAnswers: null,
  players: [],
  answers: [],
};

// === Spotify status chip ===
async function refreshSpotifyChip() {
  const chip = $('spotify-status');
  if (isLoggedIn()) {
    try {
      const me = await getCurrentSpotifyUser();
      chip.textContent = `🎧 ${me.display_name || me.id}`;
      chip.style.background = 'rgba(29, 185, 84, 0.25)';
      chip.style.color = '#39ff14';
      chip.style.cursor = 'pointer';
      chip.title = "Cliquer pour se déconnecter";
      chip.onclick = () => { logout(); window.location.reload(); };
    } catch {
      logout();
      chip.textContent = '⏺ Spotify';
    }
  } else {
    chip.textContent = '⏺ Spotify';
    chip.style.cursor = 'default';
  }
}

// === Init ===
(async function init() {
  try { await handleSpotifyCallback(); }
  catch (e) { showError('import-error', e.message); }

  // Make sure we have a Firebase Auth uid (used as hostId).
  const user = await ensureAnonAuth();
  state.hostId = user.uid;

  await refreshSpotifyChip();

  if (!isLoggedIn()) {
    showStep('login');
    $('btn-spotify-login').addEventListener('click', () => loginWithSpotify());
    return;
  }
  showStep('import');
})();

// === STEP 2 : Import playlist ===
$('btn-load-playlist').addEventListener('click', async () => {
  hideError('import-error');
  $('btn-create-room').classList.add('hidden');
  const raw = $('playlist-url').value.trim();
  if (!raw) return showError('import-error', "Colle une URL de playlist Spotify.");

  $('btn-load-playlist').disabled = true;
  try {
    const id = parseSpotifyPlaylistUrl(raw);

    // Show meta first so the host knows we hit the right playlist.
    let meta;
    try { meta = await fetchPlaylistMeta(id); } catch {}
    if (meta) {
      $('playlist-meta-block').classList.remove('hidden');
      $('playlist-meta').innerHTML = `
        ${(() => {
          const u = safeImageUrl(meta.images?.[0]?.url);
          return u ? `<img src="${u}" alt="">` : '';
        })()}
        <div class="meta-info">
          <strong>${escapeHtml(meta.name)}</strong><br>
          <small>par ${escapeHtml(meta.owner?.display_name || '?')} · ${meta.tracks?.total ?? meta.items?.total ?? '?'} morceaux</small>
        </div>
      `;
    }

    const spotifyTracks = await fetchSpotifyPlaylistTracks(id);
    if (spotifyTracks.length === 0) throw new Error("Playlist vide.");

    // Cap to maxRoundsPerGame * 2 (we'll drop the unmatched ones during enrich).
    const candidates = spotifyTracks.slice(0, appConfig.maxRoundsPerGame * 2);

    // Render placeholder rows
    $('enrich-block').classList.remove('hidden');
    state.enriched = [];
    $('track-list').innerHTML = candidates.map((t, i) => `
      <div class="track-row status-pending" data-idx="${i}">
        <div class="idx">${i + 1}</div>
        <div class="meta">
          <div class="title">${escapeHtml(t.name)}</div>
          <div class="artist">${escapeHtml(formatArtists(t.artists))}</div>
        </div>
        <span class="status-pill">…</span>
      </div>
    `).join('');

    let okN = 0, missingN = 0;
    state.enriched = await enrichTracksWithPreviews(candidates, (track, done, total) => {
      // Update progress UI
      const idx = done - 1;
      const row = $(`track-list`).querySelector(`[data-idx="${idx}"]`);
      if (row) {
        row.classList.remove('status-pending');
        if (track.playable) {
          row.classList.add('status-ok');
          row.querySelector('.status-pill').textContent = '✓ preview';
          okN++;
        } else {
          row.classList.add('status-missing');
          row.querySelector('.status-pill').textContent = '✗ pas de preview';
          missingN++;
        }
      }
      $('count-ok').textContent = okN;
      $('count-missing').textContent = missingN;
      $('count-ignored').textContent = '0';
      $('progress-bar').style.width = `${(done / total) * 100}%`;
    });

    // Cap to maxRoundsPerGame playable tracks for this game
    const playable = state.enriched.filter(t => t.playable);
    if (playable.length < 3) {
      throw new Error(
        `Seulement ${playable.length} morceaux ont une preview iTunes. ` +
        `Essaie une autre playlist (en général mainstream marche mieux).`
      );
    }
    if (playable.length > appConfig.maxRoundsPerGame) {
      const drop = playable.length - appConfig.maxRoundsPerGame;
      // Mark the extras as "ignored" in UI
      let dropped = 0;
      for (let i = state.enriched.length - 1; i >= 0 && dropped < drop; i--) {
        if (state.enriched[i].playable) {
          state.enriched[i].playable = false;
          state.enriched[i]._ignored = true;
          dropped++;
          const row = $('track-list').querySelector(`[data-idx="${i}"]`);
          if (row) {
            row.classList.remove('status-ok');
            row.classList.add('status-ignored');
            row.querySelector('.status-pill').textContent = '↘ ignoré (>max)';
          }
        }
      }
      $('count-ok').textContent = appConfig.maxRoundsPerGame;
      $('count-ignored').textContent = drop;
    }

    $('btn-create-room').classList.remove('hidden');
  } catch (e) {
    console.error(e);
    showError('import-error', e.message);
  } finally {
    $('btn-load-playlist').disabled = false;
  }
});

// === STEP 2 → 3 : Create room ===
$('btn-create-room').addEventListener('click', async () => {
  $('btn-create-room').disabled = true;
  try {
    const { roomId } = await createRoom(state.hostId);
    state.roomId = roomId;
    await addTracksToRoom(roomId, state.enriched);
    state.tracks = await fetchRoomTracks(roomId);

    $('room-code').textContent = roomId;
    const joinUrl = `${appConfig.baseUrl}/index.html?code=${roomId}`;
    $('join-url').textContent = joinUrl;

    state.unsubPlayers = listenPlayers(roomId, players => {
      // Drop the host from the player list (host is signed in anonymously
      // but does not create a player doc, so this is just defensive).
      state.players = players.filter(p => p.id !== state.hostId);
      renderLobbyPlayers();
      renderLiveScoreboard();
    });

    showStep('lobby');
  } catch (e) {
    console.error(e);
    showError('import-error', e.message);
    $('btn-create-room').disabled = false;
  }
});

function renderLobbyPlayers() {
  const list = $('player-list');
  $('player-count').textContent = state.players.length;
  if (state.players.length === 0) {
    list.innerHTML = '<p class="muted">En attente des potes…</p>';
    $('btn-start-game').disabled = true;
    return;
  }
  list.innerHTML = state.players.map(p => `
    <div class="player-chip">
      <span class="name">${escapeHtml(p.name)}</span>
      <span style="color: var(--neon-green);">🟢</span>
    </div>
  `).join('');
  $('btn-start-game').disabled = false;
}

// === STEP 3 → 4 : start game ===
$('btn-start-game').addEventListener('click', async () => {
  // playRound() appelle déjà startRound(roomId, 0) en interne — pas besoin
  // d'un startGame() séparé qui écrirait un currentRoundStartedAt en double
  // (ce qui désynchronisait l'audio des joueurs sur le round 0).
  state.roundIndex = 0;
  await playRound();
});

$('btn-cancel-room').addEventListener('click', async () => {
  if (!confirm("Annuler et supprimer la room ?")) return;
  if (state.unsubPlayers) state.unsubPlayers();
  await deleteRoom(state.roomId);
  window.location.href = './index.html';
});

// === STEP 4 : playing ===
async function playRound() {
  const track = state.tracks[state.roundIndex];
  if (!track) return finishGame();
  state.currentTrack = track;

  await startRound(state.roomId, state.roundIndex);
  showStep('playing');

  $('round-num').textContent = state.roundIndex + 1;
  $('round-total').textContent = state.tracks.length;
  const art = $('album-art');
  art.className = 'album-art mystery';
  art.innerHTML = '';
  $('answers').innerHTML = '<p class="muted">En attente des buzz…</p>';
  $('answer-count').textContent = '0';
  // Reset le bouton de fin de round à son libellé initial
  $('btn-stop-audio').textContent = '⏹ Stop & révéler';
  $('btn-stop-audio').disabled = false;

  // Audio host : joue la piste pour le présentateur. Chaque joueur a aussi
  // son propre audio synchronisé côté player.js — Blindie est conçu pour
  // les parties à distance via Discord.
  if (state.audio) { state.audio.pause(); state.audio = null; }
  state.audio = new Audio(track.previewUrl);
  state.audio.volume = 1;
  try { await state.audio.play(); }
  catch (err) { console.warn('Audio autoplay refusé', err); }

  startTimer(appConfig.defaultRoundDurationSeconds);

  if (state.unsubAnswers) state.unsubAnswers();
  state.unsubAnswers = listenAnswers(state.roomId, state.roundIndex, answers => {
    state.answers = answers;
    // En reveal on a déjà rendu state.answers avec les scores retournés par
    // scoreRound — on rerend pour propager les éventuels updates Firestore
    // (par ex. score corrigé via une seconde passe).
    if (state.step === 'reveal') renderRevealAnswers();
    else renderLiveAnswers();
  });

  state.audio.onended = () => {
    // Don't auto-reveal — host clicks "Stop & révéler".
  };
}

function startTimer(seconds) {
  clearInterval(state.timerInterval);
  let remaining = seconds;
  $('timer').textContent = remaining;
  $('timer').classList.remove('danger');
  state.timerInterval = setInterval(async () => {
    remaining--;
    $('timer').textContent = Math.max(0, remaining);
    if (remaining <= 5) $('timer').classList.add('danger');
    if (remaining <= 0) {
      clearInterval(state.timerInterval);
      if (state.audio) state.audio.pause();
      // Verrouille automatiquement la room : les joueurs ne peuvent plus
      // répondre. Le host clique ensuite sur "Révéler" pour scorer + reveal.
      try {
        await lockRound(state.roomId);
      } catch (e) { console.warn('Lock failed', e); }
      // Le bouton change de libellé pour refléter l'état "locked"
      $('btn-stop-audio').textContent = '🎯 Révéler';
    }
  }, 1000);
}

$('btn-replay').addEventListener('click', () => {
  if (!state.audio) return;
  state.audio.currentTime = 0;
  state.audio.play();
});

$('btn-stop-audio').addEventListener('click', async () => {
  // Flow unifié : que ce soit un stop anticipé ("playing") ou un click
  // après que le timer ait expiré ("locked"), on lock + score + reveal.
  if (state.audio) state.audio.pause();
  clearInterval(state.timerInterval);
  $('btn-stop-audio').disabled = true;
  try {
    // Lock si pas déjà fait (stop anticipé). Idempotent : si la room est
    // déjà "locked", c'est un no-op côté Firestore.
    await lockRound(state.roomId);
    // On re-fetch les réponses fraîchement présentes en Firestore plutôt
    // que de relire state.answers : si une réponse a été acceptée juste
    // avant le lock mais que le snapshot listener n'a pas encore propagé,
    // elle serait absente de state.answers et ne serait jamais scorée.
    const latestAnswers = await fetchAnswersForRound(
      state.roomId, state.roundIndex,
    );
    // scoreRound retourne les answers enrichis avec leurs scores : on
    // écrase state.answers pour rendre l'UI immédiatement sans attendre
    // que le listener Firestore propage l'update.
    const scored = await scoreRound(
      state.roomId,
      state.roundIndex,
      state.currentTrack,
      latestAnswers,
      { pointsTitle: appConfig.pointsTitle, pointsArtist: appConfig.pointsArtist },
    );
    state.answers = scored;
    await revealRound(state.roomId, state.currentTrack.id);
    doReveal();
  } catch (e) {
    console.error(e);
    alert("Erreur pendant le reveal : " + e.message);
  } finally {
    $('btn-stop-audio').disabled = false;
    $('btn-stop-audio').textContent = '⏹ Stop & révéler';
  }
});

function renderLiveAnswers() {
  $('answer-count').textContent = state.answers.length;
  if (state.answers.length === 0) {
    $('answers').innerHTML = '<p class="muted">En attente des buzz…</p>';
    return;
  }
  $('answers').innerHTML = state.answers
    .sort((a, b) => (a.submittedAt?.seconds || 0) - (b.submittedAt?.seconds || 0))
    .map((a, i) => `
      <div class="answer-row">
        <div>
          <span class="who">#${i + 1} ${escapeHtml(a.playerName)}</span><br>
          <span class="what">
            <small>Titre :</small> ${escapeHtml(a.titleAnswer) || '<em class="muted">—</em>'} ·
            <small>Artiste :</small> ${escapeHtml(a.artistAnswer) || '<em class="muted">—</em>'}
          </span>
        </div>
      </div>
    `).join('');
}

// === STEP 5 : reveal ===
function doReveal() {
  showStep('reveal');
  $('reveal-round-num').textContent = state.roundIndex + 1;
  $('reveal-title').textContent = state.currentTrack.title;
  $('reveal-artist').textContent = formatArtists(state.currentTrack.artists);
  const art = $('reveal-art');
  art.className = 'album-art';
  const revealImg = safeImageUrl(state.currentTrack.imageUrl);
  art.innerHTML = revealImg ? `<img src="${revealImg}" alt="">` : '🎵';

  renderRevealAnswers();
}

function renderRevealAnswers() {
  if (state.answers.length === 0) {
    $('reveal-answers').innerHTML = '<p class="muted">Personne n\'a répondu sur ce round.</p>';
    return;
  }
  $('reveal-answers').innerHTML = state.answers
    .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0))
    .map(a => {
      const cls = a.totalScore >= 2 ? 'correct' :
                  a.totalScore === 1 ? 'partial' : 'wrong';
      const detail = [
        a.scoreTitle > 0 ? `+${a.scoreTitle} titre` : null,
        a.scoreArtist > 0 ? `+${a.scoreArtist} artiste` : null,
      ].filter(Boolean).join(' · ') || '0 pt';
      return `
        <div class="answer-row ${cls}">
          <div>
            <span class="who">${escapeHtml(a.playerName)}</span>
            <span class="tag" style="margin-left:0.5rem;">${detail}</span><br>
            <span class="what">
              <small>Titre :</small> ${escapeHtml(a.titleAnswer) || '<em class="muted">—</em>'} ·
              <small>Artiste :</small> ${escapeHtml(a.artistAnswer) || '<em class="muted">—</em>'}
            </span>
          </div>
        </div>
      `;
    }).join('');
}

$('btn-next-round').addEventListener('click', async () => {
  state.roundIndex++;
  if (state.roundIndex >= state.tracks.length) return finishGame();
  // playRound() appelle déjà startRound(roomId, roundIndex) qui écrit
  // currentRoundStartedAt. Un appel séparé à nextRound() écrirait un 2e
  // timestamp et désynchroniserait l'audio des joueurs.
  await playRound();
});

$('btn-end-game').addEventListener('click', () => finishGame());

// === STEP 6 : finished ===
async function finishGame() {
  clearInterval(state.timerInterval);
  if (state.audio) state.audio.pause();
  if (state.unsubAnswers) state.unsubAnswers();
  await endGame(state.roomId);
  showStep('finished');
  renderPodium();
}

function renderPodium() {
  const sorted = [...state.players].sort((a, b) => (b.score || 0) - (a.score || 0));
  $('final-scoreboard').innerHTML = sorted.map((p, i) => `
    <div class="score-row rank-${i + 1}">
      <span class="rank">${medal(i)}</span>
      <span class="name">${escapeHtml(p.name)}</span>
      <span class="pts">${p.score || 0}</span>
    </div>
  `).join('');
}

function medal(i) { return i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`; }

// === Live scoreboard ===
function renderLiveScoreboard() {
  const sorted = [...state.players].sort((a, b) => (b.score || 0) - (a.score || 0));
  $('live-scoreboard').innerHTML = sorted.map((p, i) => `
    <div class="score-row rank-${i + 1}">
      <span class="rank">${medal(i)}</span>
      <span class="name">${escapeHtml(p.name)}</span>
      <span class="pts">${p.score || 0}</span>
    </div>
  `).join('');
}

// === Helpers ===
function showError(id, msg) {
  const el = $(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideError(id) { $(id).classList.add('hidden'); }

$('btn-back-home-host').addEventListener('click', () => {
  window.location.href = './index.html';
});

// Click-to-copy on room code & join URL
$('room-code').addEventListener('click', () => {
  navigator.clipboard.writeText($('room-code').textContent).catch(() => {});
  $('room-code').classList.add('success-flash');
  setTimeout(() => $('room-code').classList.remove('success-flash'), 600);
});
$('join-url').addEventListener('click', () => {
  navigator.clipboard.writeText($('join-url').textContent).catch(() => {});
});
