import fs from 'fs/promises';
import { ensureDir, fileExists } from './util.js';

const STATE_PATH = 'data/state.json';

export async function loadState() {
  if (!(await fileExists(STATE_PATH))) {
    await ensureDir('data');
    await fs.writeFile(STATE_PATH, JSON.stringify({ processed: {}, playlists: {} }, null, 2));
  }
  const raw = await fs.readFile(STATE_PATH, 'utf8');
  try {
    const s = JSON.parse(raw);
    if (!s.processed || typeof s.processed !== 'object') s.processed = {};
    if (!s.playlists || typeof s.playlists !== 'object') s.playlists = {};
    return s;
  } catch {
    return { processed: {}, playlists: {} };
  }
}

export async function saveState(state) {
  await ensureDir('data');
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

export async function isProcessed(videoId) {
  const state = await loadState();
  return Boolean(state.processed[videoId]);
}

export async function markProcessed(videoId, meta = {}) {
  const state = await loadState();
  state.processed[videoId] = { when: new Date().toISOString(), ...meta };
  await saveState(state);
}

export async function getProcessed(videoId) {
  const state = await loadState();
  return state.processed?.[videoId] || null;
}

export async function getPlaylistLatestPublished(playlistId) {
  const state = await loadState();
  const p = state.playlists?.[playlistId];
  return p?.latest_published_at || null;
}

export async function setPlaylistLatestPublished(playlistId, iso8601) {
  const state = await loadState();
  if (!state.playlists) state.playlists = {};
  if (!state.playlists[playlistId]) state.playlists[playlistId] = {};
  state.playlists[playlistId].latest_published_at = iso8601 || null;
  await saveState(state);
}
