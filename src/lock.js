import fs from 'fs/promises';
import path from 'path';

const LOCK_PATH = path.join('data', '.lock');

export async function acquireLock(ttlMs = 60 * 60 * 1000) {
  // Ensure data dir exists without importing util.js to avoid cycles
  await fs.mkdir('data', { recursive: true });
  try {
    const now = Date.now();
    const payload = JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() });
    await fs.writeFile(LOCK_PATH, payload, { flag: 'wx' });
    return true;
  } catch (e) {
    // Check for stale lock
    try {
      const txt = await fs.readFile(LOCK_PATH, 'utf8');
      const meta = JSON.parse(txt || '{}');
      const at = new Date(meta.at || 0).getTime();
      if (Number.isFinite(at) && (Date.now() - at > ttlMs)) {
        await fs.unlink(LOCK_PATH).catch(() => {});
        // retry once
        const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
        await fs.writeFile(LOCK_PATH, payload, { flag: 'wx' });
        return true;
      }
    } catch {}
    return false;
  }
}

export async function releaseLock() {
  try {
    await fs.unlink(LOCK_PATH);
  } catch {}
}

