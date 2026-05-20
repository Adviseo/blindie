// Generic helpers: text normalization, fuzzy matching, formatting.

// === Text normalization ===
// Used everywhere we want to compare two strings tolerantly:
// remove accents, lower-case, drop parenthetical content, drop common noise
// ("remastered", "feat.", "radio edit"…), collapse whitespace.
export function normalizeText(str) {
  if (str == null) return '';
  return String(str)
    .toLowerCase()
    // Strip diacritics (à → a, é → e…) — ̀–ͯ are combining marks
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    // Drop bracketed/parenthesized junk: "(Remastered 2011)", "[Live]"…
    .replace(/[\[\(\{][^\]\)\}]*[\]\)\}]/g, ' ')
    // Drop "feat. / ft. / featuring X"
    .replace(/\b(feat\.?|ft\.?|featuring|with)\b.*$/i, ' ')
    // Drop common version qualifiers
    .replace(/\b(remaster(ed)?|radio edit|extended( mix)?|live|version|edit|mix|mono|stereo|deluxe|bonus track|acoustic)\b/g, ' ')
    // Drop punctuation
    .replace(/['’`"".,;:!?\-–—_\/\\&]+/g, ' ')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

// Tokenize on whitespace after normalization.
function tokens(str) {
  return normalizeText(str).split(' ').filter(Boolean);
}

// === String similarity ===
// Returns a number in [0, 1]. Uses a hybrid:
//   - 1.0 on exact normalized match
//   - 0.9 if one is a substring of the other (and not too short)
//   - Otherwise: Jaccard similarity on token sets, blended with bigram dice.
// Robust enough for "Bohemian Rhapsody" vs "bohemian rhapsody - remastered".
export function scoreMatch(expected, candidate) {
  const a = normalizeText(expected);
  const b = normalizeText(candidate);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;

  if (a.length >= 4 && b.length >= 4) {
    if (a.includes(b) || b.includes(a)) return 0.9;
  }

  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  const inter = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  const jaccard = union === 0 ? 0 : inter / union;

  const dice = bigramDice(a, b);

  // Weighted blend — bigram dice catches typos, jaccard catches order/extras.
  return 0.6 * dice + 0.4 * jaccard;
}

function bigramDice(a, b) {
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.size === 0 || bb.size === 0) return 0;
  let inter = 0;
  for (const g of ba) if (bb.has(g)) inter++;
  return (2 * inter) / (ba.size + bb.size);
}

function bigrams(str) {
  const s = new Set();
  const t = str.replace(/\s+/g, ' ');
  for (let i = 0; i < t.length - 1; i++) s.add(t.slice(i, i + 2));
  return s;
}

// Convenience: does this candidate "match" the expected value at threshold?
export function isMatch(expected, candidate, threshold = 0.75) {
  return scoreMatch(expected, candidate) >= threshold;
}

// === Random codes ===
// Code de 6 caractères, alphabet sans caractères ambigus (no 0/O, 1/I, etc.).
// Génération via crypto.getRandomValues — pas Math.random — pour éviter les
// collisions/devinabilité avec un PRNG faible.
export function generateJoinCode(len = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) {
    // Mod 32 = parfaitement uniforme car 256 % 32 == 0.
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

// === URL safety ===
// Renvoie l'URL si c'est une https:// well-formed, sinon null.
// À utiliser avant d'injecter une URL externe dans innerHTML (<img src=...>).
// Bloque javascript:, data:, blob:, http:, etc.
export function safeImageUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

// === Misc ===
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function formatArtists(artists) {
  if (!artists) return '';
  if (Array.isArray(artists)) return artists.join(', ');
  return String(artists);
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
