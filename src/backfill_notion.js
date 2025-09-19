import './env.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createNotionPage, normalizeNotionPageId } from './notion.js';
import { loadState, saveState } from './state.js';

function parseMarkdownHeader(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  // Title line
  const titleLine = lines[i] || '';
  const title = titleLine.startsWith('#') ? titleLine.replace(/^#+\s*/, '').trim() : '';
  i++;
  // Skip any blank lines after title
  while (i < lines.length && !lines[i].trim()) i++;
  let channel = '';
  let url = '';
  let videoId = '';
  let published = '';
  for (; i < Math.min(lines.length, 12); i++) {
    const line = lines[i];
    if (!line.trim()) { i++; break; }
    const mChan = /^-\s*Channel:\s*(.*)$/i.exec(line);
    const mUrl = /^-\s*URL:\s*(.*)$/i.exec(line);
    const mVid = /^-\s*Video ID:\s*(.*)$/i.exec(line);
    const mPub = /^-\s*Published:\s*(.*)$/i.exec(line);
    if (mChan) channel = mChan[1].trim();
    if (mUrl) url = mUrl[1].trim();
    if (mVid) videoId = mVid[1].trim();
    if (mPub) published = mPub[1].trim();
  }
  const summary = lines.slice(i).join('\n').trim();
  return { title, channel, url, videoId, published, summary };
}

async function main() {
  if (!process.env.NOTION_TOKEN || !process.env.NOTION_PARENT_PAGE_ID) {
    console.error('Backfill requires NOTION_TOKEN and NOTION_PARENT_PAGE_ID in .env.local');
    process.exitCode = 1;
    return;
  }
  const parentId = normalizeNotionPageId(process.env.NOTION_PARENT_PAGE_ID);
  const outDir = 'output';
  let files;
  try {
    files = await fs.readdir(outDir);
  } catch (e) {
    console.error('No output/ directory found. Nothing to backfill.');
    return;
  }
  const mdFiles = files.filter((f) => f.toLowerCase().endsWith('.md') && !f.startsWith('._'));
  if (!mdFiles.length) {
    console.log('No Markdown files in output/. Nothing to backfill.');
    return;
  }
  const state = await loadState();
  let created = 0;
  for (const f of mdFiles) {
    const full = path.join(outDir, f);
    let text;
    try {
      text = await fs.readFile(full, 'utf8');
    } catch {
      continue;
    }
    const { title, channel, url, videoId, summary } = parseMarkdownHeader(text);
    if (!videoId) {
      // try to parse from filename "(...VIDEOID).md"
      const m = /\(([A-Za-z0-9_-]{6,})\)\.md$/i.exec(f);
      if (m) {
        state.processed[m[1]] = state.processed[m[1]] || {};
      }
    }
    if (!videoId) {
      console.warn('Skipping (no videoId):', f);
      continue;
    }
    const entry = state.processed?.[videoId];
    if (entry && entry.notion_page_id) {
      continue; // already in notion
    }
    try {
      const page = await createNotionPage({
        title: (title || 'Untitled').slice(0, 100),
        markdown: summary || '',
        parentPageId: parentId,
        meta: { url, channel, videoId },
      });
      state.processed[videoId] = {
        ...(entry || {}),
        when: new Date().toISOString(),
        output: full,
        notion_page_id: page?.id,
      };
      await saveState(state);
      created++;
      console.log('Backfilled to Notion:', page?.url || page?.id, 'from', f);
    } catch (e) {
      console.warn('Failed to backfill', f, '-', e.message);
    }
  }
  console.log(`Backfill complete. Created ${created} Notion page(s).`);
}

main();
