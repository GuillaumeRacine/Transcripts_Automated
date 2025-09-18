import fs from 'fs/promises';
import path from 'path';

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

export function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function chunkText(text, maxChars = 1800) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    // try to break on a paragraph or sentence boundary
    const slice = text.slice(start, end);
    const lastBreak = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('. '), slice.lastIndexOf('\n'));
    if (lastBreak > 200) {
      end = start + lastBreak + 1;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks.filter(Boolean);
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.includes('=') ? a.split('=') : [a, argv[i + 1]];
      const key = k.replace(/^--/, '');
      if (!a.includes('=') && (v && !v.startsWith('--'))) {
        args[key] = v;
        i++;
      } else {
        args[key] = a.includes('=') ? v : true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

export function extractPlaylistUrlsFromMarkdown(markdown) {
  // Match youtube.com (with or without www) playlist URLs with a list parameter
  const urlRegex = /(https?:\/\/(?:www\.)?youtube\.com\/playlist\?list=[A-Za-z0-9_-]+)/g;
  const urls = new Set();
  let match;
  while ((match = urlRegex.exec(markdown)) !== null) {
    urls.add(match[1]);
  }
  return Array.from(urls);
}
