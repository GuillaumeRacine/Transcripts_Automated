import { google } from 'googleapis';
import { YoutubeTranscript } from 'youtube-transcript';
import { getSubtitles } from 'youtube-captions-scraper';
import ytDlp from 'yt-dlp-exec';
import fs from 'fs/promises';
import path from 'path';
import { ensureDir } from './util.js';

function iso8601DurationToSeconds(iso) {
  if (!iso || typeof iso !== 'string') return null;
  // Example: PT1H2M30S, PT45M, PT59S
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!m) return null;
  const h = parseInt(m[1] || '0', 10);
  const mi = parseInt(m[2] || '0', 10);
  const s = parseInt(m[3] || '0', 10);
  return h * 3600 + mi * 60 + s;
}

function getPlaylistIdFromUrl(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('list');
  } catch {
    return null;
  }
}

export async function listPlaylistVideos(playlistUrl) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error('Missing YOUTUBE_API_KEY');
  const playlistId = getPlaylistIdFromUrl(playlistUrl) || playlistUrl;
  const youtube = google.youtube({ version: 'v3', auth: apiKey });

  let nextPageToken = undefined;
  const items = [];
  try {
    do {
      const res = await youtube.playlistItems.list({
        part: ['snippet','contentDetails'],
        playlistId,
        maxResults: 50,
        pageToken: nextPageToken,
      });
      nextPageToken = res.data.nextPageToken || undefined;
      for (const it of res.data.items || []) {
        const vid = it.contentDetails?.videoId;
        const title = it.snippet?.title || '';
        const channelTitle = it.snippet?.videoOwnerChannelTitle || it.snippet?.channelTitle || '';
        items.push({
          videoId: vid,
          title,
          url: vid ? `https://www.youtube.com/watch?v=${vid}` : '',
          author: channelTitle,
          publishedAt: it.contentDetails?.videoPublishedAt || it.snippet?.publishedAt,
          position: it.snippet?.position,
          thumbnail: it.snippet?.thumbnails?.high?.url || it.snippet?.thumbnails?.default?.url || null,
          durationSec: undefined,
          durationISO: undefined,
        });
      }
    } while (nextPageToken);
    // Enrich with durations via videos.list (batch up to 50)
    const ids = items.map((x) => x.videoId).filter(Boolean);
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      if (!batch.length) continue;
      try {
        const res = await youtube.videos.list({ part: ['contentDetails'], id: batch });
        const map = new Map();
        for (const v of res.data.items || []) {
          const id = v.id;
          const iso = v.contentDetails?.duration;
          map.set(id, { iso, sec: iso8601DurationToSeconds(iso) });
        }
        for (const it of items) {
          if (map.has(it.videoId)) {
            const { iso, sec } = map.get(it.videoId);
            it.durationISO = iso;
            it.durationSec = sec;
          }
        }
      } catch (e) {
        // If duration enrichment fails, proceed without durations.
      }
    }
  } catch (e) {
    const code = e?.code || e?.response?.status || 'UNKNOWN';
    const reason = e?.message || 'Request failed';
    const isNet = String(code) === 'ENOTFOUND' || /ENOTFOUND|ECONN|EAI_AGAIN/i.test(String(reason));
    const hint = isNet
      ? 'Network unavailable or blocked. If running in a sandbox, enable network. Otherwise, check your internet connection.'
      : 'Verify YOUTUBE_API_KEY validity and YouTube Data API v3 access/quota.';
    throw new Error(`YouTube playlist fetch failed (${code}): ${reason}. ${hint}`);
  }

  return items.filter((x) => x.videoId);
}

export function getVideoIdFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com')) {
      return u.searchParams.get('v');
    }
    if (u.hostname === 'youtu.be') {
      return u.pathname.slice(1);
    }
    return null;
  } catch {
    return null;
  }
}

export async function getVideoMeta(videoId) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const youtube = google.youtube({ version: 'v3', auth: apiKey });
  let it;
  try {
    const res = await youtube.videos.list({ part: ['snippet','contentDetails'], id: [videoId] });
    it = (res.data.items || [])[0];
  } catch (e) {
    const code = e?.code || e?.response?.status || 'UNKNOWN';
    const reason = e?.message || 'Request failed';
    const isNet = String(code) === 'ENOTFOUND' || /ENOTFOUND|ECONN|EAI_AGAIN/i.test(String(reason));
    const hint = isNet
      ? 'Network unavailable or blocked. If running in a sandbox, enable network. Otherwise, check your internet connection.'
      : 'Verify YOUTUBE_API_KEY validity and YouTube Data API v3 access/quota.';
    throw new Error(`YouTube video metadata fetch failed (${code}): ${reason}. ${hint}`);
  }
  if (!it) return { videoId, title: '(unknown title)', author: '', url: `https://www.youtube.com/watch?v=${videoId}`, durationISO: undefined, durationSec: undefined, publishedAt: undefined };
  const title = it.snippet?.title || '(untitled)';
  const author = it.snippet?.channelTitle || '';
  const durationISO = it.contentDetails?.duration;
  const durationSec = durationISO ? iso8601DurationToSeconds(durationISO) : undefined;
  const publishedAt = it.snippet?.publishedAt;
  return { videoId, title, author, url: `https://www.youtube.com/watch?v=${videoId}` , durationISO, durationSec, publishedAt };
}

export async function fetchTranscriptText(videoId) {
  // Try youtube-transcript first
  const segments = await YoutubeTranscript.fetchTranscript(videoId).catch(() => null);
  if (segments && Array.isArray(segments) && segments.length) {
    const lines = segments.map((s) => s.text.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const parts = [];
    for (let i = 0; i < lines.length; i += 10) {
      parts.push(lines.slice(i, i + 10).join(' '));
    }
    return parts.join('\n\n');
  }

  // Fallback: youtube-captions-scraper (requires lang)
  try {
    const caps = await getSubtitles({ videoID: videoId, lang: 'en' });
    if (caps && caps.length) {
      const lines = caps.map((c) => String(c.text || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      const parts = [];
      for (let i = 0; i < lines.length; i += 10) {
        parts.push(lines.slice(i, i + 10).join(' '));
      }
      return parts.join('\n\n');
    }
  } catch {}

  // Fallback: yt-dlp auto-generated subs (en)
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const tmpDir = path.join('data', 'tmp');
    await ensureDir(tmpDir);
    const outTpl = path.join(tmpDir, `${videoId}.%(ext)s`);
    await ytDlp(url, {
      skipDownload: true,
      writeAutoSub: true,
      subLangs: 'en',
      subFormat: 'vtt',
      output: outTpl,
      noWarnings: true,
      // retries
      retries: 3,
    });
    // yt-dlp may create `${videoId}.en.vtt` or `${videoId}.vtt`
    const candidates = [
      path.join(tmpDir, `${videoId}.en.vtt`),
      path.join(tmpDir, `${videoId}.vtt`),
      path.join(tmpDir, `${videoId}.live_chat.json`),
    ];
    for (const p of candidates) {
      try {
        const txt = await fs.readFile(p, 'utf8');
        if (p.endsWith('.vtt')) {
          const text = vttToText(txt);
          if (text) return text;
        }
        // ignore json/live_chat
      } catch {}
    }
  } catch {}

  return null;
}

function vttToText(vtt) {
  // Strip WEBVTT header and timestamps; keep text lines; collapse.
  const lines = vtt.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    if (/^(WEBVTT|Kind:|Language:)/i.test(line)) continue;
    if (/^\d+$/.test(line)) continue; // cue number
    if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->/.test(line)) continue; // timestamp
    out.push(line.trim());
  }
  // Join and normalize spaces, keep paragraph breaks roughly every 10 lines
  const text = out.join('\n');
  const parts = [];
  const arr = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < arr.length; i += 10) {
    parts.push(arr.slice(i, i + 10).join(' '));
  }
  return parts.join('\n\n');
}
