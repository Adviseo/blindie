// Spotify OAuth 2.0 — Authorization Code with PKCE.
// We only use Spotify to read playlist metadata (title, artists, album, image).
// Audio playback goes through iTunes (see previews.js), so we DO NOT touch
// preview_url here and we DO NOT need any Premium / Web Playback SDK.

import { spotifyConfig } from './config.js';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';

const VERIFIER_KEY = 'blindie.spotify.verifier';
const TOKEN_KEY = 'blindie.spotify.token';

// ===================================================================
// PKCE helpers
// ===================================================================

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sha256(str) {
  const data = new TextEncoder().encode(str);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

export function generateCodeVerifier(len = 96) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return base64url(bytes).slice(0, len);
}

export async function generateCodeChallenge(verifier) {
  return base64url(await sha256(verifier));
}

// ===================================================================
// Login flow
// ===================================================================

export async function loginWithSpotify() {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  sessionStorage.setItem(VERIFIER_KEY, verifier);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: spotifyConfig.clientId,
    scope: spotifyConfig.scopes,
    redirect_uri: spotifyConfig.redirectUri,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  window.location.href = `${AUTH_URL}?${params.toString()}`;
}

// Called on the redirect_uri page — completes the PKCE exchange if there is
// a ?code= in the URL. Returns true if a token was obtained, false if there
// was nothing to do. Throws on Spotify errors.
export async function handleSpotifyCallback() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (error) throw new Error(`Spotify a refusé : ${error}`);
  if (!code) return false;

  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error("Code verifier perdu — relance le login.");

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: spotifyConfig.redirectUri,
    client_id: spotifyConfig.clientId,
    code_verifier: verifier,
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`Token exchange failed (${r.status})`);
  const data = await r.json();
  storeToken(data);

  // Clean the URL so refresh doesn't re-use the code (codes are one-shot).
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  window.history.replaceState({}, document.title, url.toString());
  return true;
}

// ===================================================================
// Token storage / refresh
// ===================================================================

function storeToken(data) {
  const expiresAt = Date.now() + (data.expires_in - 60) * 1000;
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
  }));
}

function readToken() {
  const raw = sessionStorage.getItem(TOKEN_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function refreshAccessToken(tok) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tok.refreshToken,
    client_id: spotifyConfig.clientId,
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error("Refresh token a échoué — relance le login.");
  const data = await r.json();
  if (!data.refresh_token) data.refresh_token = tok.refreshToken;
  storeToken(data);
  return data.access_token;
}

export async function getSpotifyAccessToken() {
  const tok = readToken();
  if (!tok) return null;
  if (Date.now() < tok.expiresAt) return tok.accessToken;
  return await refreshAccessToken(tok);
}

export function isLoggedIn() {
  return !!readToken();
}

export function logout() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
}

// ===================================================================
// API calls
// ===================================================================

async function api(path) {
  const token = await getSpotifyAccessToken();
  if (!token) throw new Error("Pas connecté à Spotify.");
  const r = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    // 403 sur une playlist : presque toujours une playlist éditoriale Spotify
    // (préfixe 37i9dQZF1...) bloquée pour les apps en Development mode
    // depuis novembre 2024. On donne un message explicite.
    if (r.status === 403 && /\/playlists\/37i9dQZF1/.test(path)) {
      throw new Error(
        "Spotify bloque les playlists éditoriales (Today's Top Hits, Daily Mix…) " +
        "pour les apps en Development mode depuis nov. 2024. " +
        "Utilise une playlist créée par un user (la tienne ou celle d'un pote)."
      );
    }
    if (r.status === 403) {
      throw new Error(
        "Spotify a refusé (403). Vérifie que tu es dans User Management du " +
        "dashboard Spotify, ou utilise une autre playlist."
      );
    }
    const msg = await r.text();
    throw new Error(`Spotify API ${r.status}: ${msg.slice(0, 200)}`);
  }
  return r.json();
}

export async function getCurrentSpotifyUser() {
  return api('/me');
}

// Accepts:
//   - https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=...
//   - spotify:playlist:37i9dQZF1DXcBWIGoYBM5M
//   - 37i9dQZF1DXcBWIGoYBM5M (raw)
// Returns the playlist ID.
export function parseSpotifyPlaylistUrl(input) {
  if (!input) throw new Error("URL ou ID manquant.");
  const s = String(input).trim();

  const urlMatch = s.match(/playlist[\/:]([a-zA-Z0-9]+)/);
  if (urlMatch) return urlMatch[1];

  if (/^[a-zA-Z0-9]{20,30}$/.test(s)) return s;

  throw new Error("URL ou ID de playlist invalide.");
}

// Fetches all tracks of a playlist (auto-paginates).
// Returns an array of normalized track objects:
//   { id, name, artists: string[], album, image, durationMs }
export async function fetchSpotifyPlaylistTracks(playlistId) {
  const fields =
    'items(track(id,name,artists(name),album(name,images),duration_ms)),next';
  let url = `/playlists/${playlistId}/tracks?limit=50&fields=${encodeURIComponent(fields)}`;
  const all = [];
  while (url) {
    const data = await api(url);
    for (const item of data.items || []) {
      const t = item.track;
      if (!t || !t.id) continue;
      all.push(normalizeSpotifyTrack(t));
    }
    if (data.next) {
      const u = new URL(data.next);
      url = u.pathname.replace('/v1', '') + u.search;
    } else {
      url = null;
    }
  }
  return all;
}

export function normalizeSpotifyTrack(t) {
  return {
    id: t.id,
    name: t.name,
    artists: (t.artists || []).map(a => a.name),
    album: t.album?.name || null,
    image: t.album?.images?.[0]?.url || null,
    durationMs: t.duration_ms || null,
  };
}

// Fetch playlist meta (name, owner, image) — used to display a confirmation
// before enriching with iTunes previews.
export async function fetchPlaylistMeta(playlistId) {
  return api(`/playlists/${playlistId}?fields=name,owner(display_name),images,tracks(total)`);
}
