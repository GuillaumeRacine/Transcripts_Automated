import fs from 'fs/promises';
import { ensureDir, fileExists } from './util.js';

const STATE_PATH = 'data/state.json';

export async function loadState() {
  if (!(await fileExists(STATE_PATH))) {
    await ensureDir('data');
    await fs.writeFile(STATE_PATH, JSON.stringify({ processed: {} }, null, 2));
  }
  const raw = await fs.readFile(STATE_PATH, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return { processed: {} };
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

