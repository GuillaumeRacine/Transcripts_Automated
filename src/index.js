import './env.js';
import fs from 'fs/promises';
import path from 'path';
import { parseArgs, extractPlaylistUrlsFromMarkdown, ensureDir, sanitizeFilename } from './util.js';
import { listPlaylistVideos, fetchTranscriptText, getVideoIdFromUrl, getVideoMeta, getPlaylistIdFromUrl } from './youtube.js';
import { isProcessed, markProcessed, getPlaylistLatestPublished, setPlaylistLatestPublished, getProcessed } from './state.js';
import { summarizeTranscriptFull } from './summarize.js';
import { createNotionPage, normalizeNotionPageId } from './notion.js';
import { acquireLock, releaseLock } from './lock.js';

const args = parseArgs(process.argv);

async function main() {
  // Always check .env.local for Codex and remember those
  // (env is loaded via dotenv/config)

  const playlistsPath = args.playlists || 'playlists.md';
  const watch = Boolean(args.watch || process.env.WATCH);
  const intervalMin = Number(args.interval || process.env.POLL_INTERVAL_MINUTES || 60);
  const contextPath = process.env.USER_CONTEXT_PATH || args.context;
  const dryRun = Boolean(args["dry-run"] || args.dryRun);
  // Notion is attempted automatically when configured; disabling is not supported.
  const videoUrl = args.video || args.v; // single video mode
  const sampleChars = args.sample ? Number(args.sample) : undefined;
  const limit = args.limit ? Number(args.limit) : undefined; // max unprocessed videos to handle per run
  const minMinutes = args["min-minutes"] ? Number(args["min-minutes"]) : (process.env.MIN_VIDEO_MINUTES ? Number(process.env.MIN_VIDEO_MINUTES) : 25);
  const ignoreMinDuration = Boolean(args["ignore-min-duration"] || process.env.IGNORE_MIN_DURATION === '1');

  await ensureDir('output');
  // Acquire a simple process lock to prevent concurrent runs in production
  const gotLock = await acquireLock();
  if (!gotLock) {
    console.error('Another instance appears to be running (lock present). Exiting.');
    process.exitCode = 1;
    return;
  }
  process.on('exit', () => { releaseLock(); });
  process.on('SIGINT', async () => { await releaseLock(); process.exit(1); });
  process.on('SIGTERM', async () => { await releaseLock(); process.exit(1); });

  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY in .env.local');
    console.error('  - Copy .env.local.example to .env.local and add your key.');
    console.error('  - Ensure network is available to reach the OpenAI API.');
    process.exitCode = 1;
    return;
  }
  if (!process.env.YOUTUBE_API_KEY) {
    console.error('Missing YOUTUBE_API_KEY in .env.local');
    console.error('  - Create a YouTube Data API v3 key and set YOUTUBE_API_KEY.');
    console.error('  - Ensure the key has quota and the network is available.');
    process.exitCode = 1;
    return;
  }
  if (!process.env.NOTION_TOKEN || !process.env.NOTION_PARENT_PAGE_ID) {
    console.error('Notion is required: set NOTION_TOKEN and NOTION_PARENT_PAGE_ID in .env.local');
    console.error('  - Share the parent page with your integration in Notion.');
    console.error('  - You can paste the page URL or UUID for NOTION_PARENT_PAGE_ID.');
    process.exitCode = 1;
    return;
  }

  if (!videoUrl && !(await fileExistsSafe(playlistsPath))) {
    console.error(`Playlists file not found: ${playlistsPath}`);
    process.exitCode = 1;
    return;
  }

  const loop = async () => {
    if (videoUrl) {
      await runSingleVideo({ videoUrl, contextPath, dryRun, sampleChars, minMinutes, ignoreMinDuration });
    } else {
      await runOnce({ playlistsPath, contextPath, dryRun, sampleChars, limit, minMinutes });
    }
  };

  await loop();
  if (watch) {
    console.log(`Watching every ${intervalMin} min. Ctrl+C to stop.`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await sleepSafe(intervalMin * 60 * 1000);
      await loop();
    }
  }
}

async function runOnce({ playlistsPath, contextPath, dryRun, sampleChars, limit, minMinutes }) {
  const md = await fs.readFile(playlistsPath, 'utf8');
  const urls = extractPlaylistUrlsFromMarkdown(md);
  if (!urls.length) {
    console.log('No YouTube playlist URLs found in the markdown file.');
    return;
  }
  console.log(`Found ${urls.length} playlists. Checking for new videos...`);
  let processedCount = 0;

  for (const url of urls) {
    try {
      const items = await listPlaylistVideos(url);
      console.log(`Playlist ${url} has ${items.length} items.`);
      const playlistId = getPlaylistIdFromUrl(url) || url;
      const minSec = Number.isFinite(minMinutes) ? Math.max(0, minMinutes) * 60 : 25 * 60;

      // Filter by duration if known
      const eligible = items.filter((it) => (it.durationSec == null) || (it.durationSec >= minSec));
      const skippedShort = items.length - eligible.length;
      if (skippedShort > 0) {
        console.log(`Skipping ${skippedShort} short videos (< ${Math.round(minSec/60)} min).`);
      }

      // Determine latest publishedAt in the playlist
      const toTime = (p) => {
        if (!p) return NaN;
        const t = new Date(p).getTime();
        return Number.isFinite(t) ? t : NaN;
      };
      const eligibleWithTime = eligible.filter((it) => Number.isFinite(toTime(it.publishedAt)));
      const latestItem = eligibleWithTime.reduce((acc, cur) => {
        return (!acc || toTime(cur.publishedAt) > toTime(acc.publishedAt)) ? cur : acc;
      }, null);
      const allWithTime = items.filter((it) => Number.isFinite(toTime(it.publishedAt)));
      const latestOverall = allWithTime.reduce((acc, cur) => {
        return (!acc || toTime(cur.publishedAt) > toTime(acc.publishedAt)) ? cur : acc;
      }, null);

      const baselineIso = await getPlaylistLatestPublished(playlistId);
      let candidates;
      if (!baselineIso) {
        // First run for this playlist: process only the latest video as baseline
        candidates = latestItem ? [latestItem] : [];
        if (latestItem) {
          console.log(`No baseline for playlist yet. Will process latest published video: ${latestItem.title}`);
        } else {
          console.log('No eligible items with a valid published date.');
        }
      } else {
        const baselineMs = toTime(baselineIso);
        candidates = eligibleWithTime.filter((it) => toTime(it.publishedAt) > baselineMs);
        // Sort by publishedAt ascending so we process in order
        candidates.sort((a, b) => toTime(a.publishedAt) - toTime(b.publishedAt));
        console.log(`Baseline for playlist ${playlistId}: ${formatDateYMD(baselineIso)}. New candidates: ${candidates.length}.`);
      }

      let maxProcessedPub = baselineIso ? new Date(baselineIso).toISOString() : null;
      for (const item of candidates) {
        const { videoId } = item;
        if (!videoId) continue;
        if (limit && processedCount >= limit) {
          console.log(`Reached processing limit (${limit}). Stopping.`);
          break;
        }
        if (await isProcessed(videoId)) {
          // Special case: if this is the first run (no baseline) and this item is the latest
          // and a prior run only marked it as too_old, allow re-processing now.
          const prev = await getProcessed(videoId);
          const isLatest = latestItem && latestItem.videoId === videoId;
          const wasTooOld = prev && prev.skipped && prev.reason === 'too_old';
          if (!( !baselineIso && isLatest && wasTooOld )) {
            continue;
          }
        }

        console.log(`Processing video: ${item.title} (${videoId}) published ${formatDateYMD(item.publishedAt) || 'unknown'}`);
        if (dryRun) {
          console.log('  [dry-run] Would fetch transcript, summarize, write Markdown, and create Notion page.');
          processedCount++;
          if (item.publishedAt && (!maxProcessedPub || new Date(item.publishedAt) > new Date(maxProcessedPub))) {
            maxProcessedPub = new Date(item.publishedAt).toISOString();
          }
          continue;
        }
        const transcriptFull = await fetchTranscriptText(videoId);
        let transcript = transcriptFull;
        if (!transcript) {
          console.warn(`No transcript available for ${videoId}. Skipping.`);
          await markProcessed(videoId, { skipped: true, reason: 'no_transcript', playlist_id: playlistId });
          if (item.publishedAt && (!maxProcessedPub || new Date(item.publishedAt) > new Date(maxProcessedPub))) {
            maxProcessedPub = new Date(item.publishedAt).toISOString();
          }
          continue;
        }
        if (sampleChars && Number.isFinite(sampleChars)) {
          transcript = transcript.slice(0, sampleChars);
        }

        const summary = await summarizeTranscriptFull(transcript, {
          title: item.title,
          author: item.author,
          url: item.url,
        }, { contextPath });

        const filename = await writeMarkdownOutput(item, summary);
        console.log(`Wrote ${filename}`);

        // Notion publish (required)
        if (process.env.NOTION_TOKEN && process.env.NOTION_PARENT_PAGE_ID) {
          const parentId = normalizeNotionPageId(process.env.NOTION_PARENT_PAGE_ID);
          if (!/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(parentId)) {
            console.warn('NOTION_PARENT_PAGE_ID appears invalid. Provide a Notion page URL or a UUID ID.');
            console.warn('  Example: https://www.notion.so/workspace/Page-Name-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
          }
          const pageTitle = `${item.title}`.slice(0, 100);
          try {
            const page = await createNotionPage({
              title: pageTitle,
              markdown: summary,
              parentPageId: parentId,
              meta: { url: item.url, channel: item.author, videoId: item.videoId },
            });
            console.log(`Created Notion page: ${page?.url || page?.id}`);
            await markProcessed(videoId, { output: filename, notion_page_id: page?.id, playlist_id: playlistId });
            processedCount++;
            if (item.publishedAt && (!maxProcessedPub || new Date(item.publishedAt) > new Date(maxProcessedPub))) {
              maxProcessedPub = new Date(item.publishedAt).toISOString();
            }
          } catch (e) {
            console.warn(`Failed to create Notion page: ${e.message}`);
            console.warn('  Troubleshooting:');
            console.warn('   - Ensure NOTION_TOKEN is for an internal integration.');
            console.warn('   - Share the parent page with the integration (Notion Share menu).');
            console.warn('   - Verify NOTION_PARENT_PAGE_ID is the correct parent page.');
            // Do not mark processed on Notion failure to allow retry later
          }
        } else {
          // This branch should not happen due to startup guard
          console.warn('Notion is not configured (missing NOTION_TOKEN or NOTION_PARENT_PAGE_ID). Aborting item.');
        }
      }
      // If no baseline existed and nothing updated maxProcessedPub, set to latest OVERALL publishedAt
      if (!baselineIso && !maxProcessedPub && latestOverall?.publishedAt) {
        maxProcessedPub = new Date(latestOverall.publishedAt).toISOString();
      }
      // Update playlist baseline if we have a value
      if (maxProcessedPub) {
        await setPlaylistLatestPublished(playlistId, maxProcessedPub);
      }
    } catch (e) {
      console.warn(`Failed playlist ${url}: ${e.message}`);
    }
  }
}

async function runSingleVideo({ videoUrl, contextPath, dryRun, sampleChars, minMinutes, ignoreMinDuration }) {
  const videoId = getVideoIdFromUrl(videoUrl) || videoUrl;
  if (!videoId) {
    console.error('Could not parse video ID from URL:', videoUrl);
    return;
  }
  if (await isProcessed(videoId)) {
    console.log('Video already processed:', videoId);
    return;
  }
  if (dryRun) {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    console.log(`Processing single video [dry-run]: ${videoId}`);
    console.log('  [dry-run] Would fetch transcript, summarize, write Markdown, and create Notion page.');
    console.log('  [dry-run] Notion parent:', process.env.NOTION_PARENT_PAGE_ID ? 'configured' : 'not configured');
    return;
  }
  let meta;
  try {
    meta = await getVideoMeta(videoId);
  } catch (e) {
    console.error(String(e.message || e));
    console.error('Hint: If you are running in a restricted sandbox, enable network access.');
    return;
  }
  // Duration gate for single-video mode if duration is known
  const minSec = Number.isFinite(minMinutes) ? Math.max(0, minMinutes) * 60 : 25 * 60;
  if (!ignoreMinDuration && typeof meta.durationSec === 'number' && meta.durationSec < minSec) {
    const mm = Math.floor(meta.durationSec / 60);
    const ss = String(meta.durationSec % 60).padStart(2, '0');
    console.log(`Skipping short video (${mm}:${ss} < ${Math.round(minSec/60)} min): ${meta.title} (${videoId})`);
    await markProcessed(videoId, { skipped: true, reason: 'too_short', duration_sec: meta.durationSec });
    return;
  }
  // Published-time gate: only process if published within the last 24 hours
  const cutoffMs = Date.now() - 24 * 60 * 60 * 1000; // 24 hours
  const pubMs = meta.publishedAt ? new Date(meta.publishedAt).getTime() : NaN;
  if (!Number.isFinite(pubMs) || pubMs < cutoffMs) {
    const pub = formatDateYMD(meta.publishedAt) || 'unknown';
    console.log(`Skipping old video (>24h): ${meta.title} (${videoId}) published ${pub}`);
    await markProcessed(videoId, { skipped: true, reason: 'too_old', published_at: meta.publishedAt || null });
    return;
  }
  console.log(`Processing single video: ${meta.title} (${videoId})`);
  const transcriptFull = await fetchTranscriptText(videoId);
  if (!transcriptFull) {
    console.warn('No transcript available.');
    await markProcessed(videoId, { skipped: true, reason: 'no_transcript' });
    return;
  }
  const transcript = sampleChars && Number.isFinite(sampleChars) ? transcriptFull.slice(0, sampleChars) : transcriptFull;
  const summary = await summarizeTranscriptFull(transcript, { title: meta.title, author: meta.author, url: meta.url }, { contextPath });
  const filename = await writeMarkdownOutput({ ...meta }, summary);
  console.log('Wrote', filename);
  if (process.env.NOTION_TOKEN && process.env.NOTION_PARENT_PAGE_ID) {
    const parentId = normalizeNotionPageId(process.env.NOTION_PARENT_PAGE_ID);
    if (!/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(parentId)) {
      console.warn('NOTION_PARENT_PAGE_ID appears invalid. Provide a Notion page URL or a UUID ID.');
      console.warn('  Example: https://www.notion.so/workspace/Page-Name-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    }
    try {
      const page = await createNotionPage({ title: meta.title.slice(0, 100), markdown: summary, parentPageId: parentId, meta: { url: meta.url, channel: meta.author, videoId: meta.videoId } });
      console.log('Created Notion page:', page?.url || page?.id);
      await markProcessed(videoId, { output: filename, notion_page_id: page?.id });
    } catch (e) {
      console.warn('Failed to create Notion page:', e.message);
      console.warn('  Troubleshooting:');
      console.warn('   - Ensure NOTION_TOKEN is for an internal integration.');
      console.warn('   - Share the parent page with the integration (Notion Share menu).');
      console.warn('   - Verify NOTION_PARENT_PAGE_ID is the correct parent page.');
      // Do not mark processed on Notion failure to allow retry later
    }
  } else {
    console.warn('Notion is not configured (missing NOTION_TOKEN or NOTION_PARENT_PAGE_ID). Skipping Notion publish.');
    // Do not mark processed if Notion is required
  }
}

async function writeMarkdownOutput(item, summary) {
  const dateStr = formatDateYMD(item.publishedAt) || new Date().toISOString().slice(0, 10);
  const base = `${dateStr} - ${sanitizeFilename(item.author || 'Unknown')} - ${sanitizeFilename(item.title)} (${item.videoId}).md`;
  const outPath = path.join('output', base);
  const header = `# ${item.title}\n\n- Channel: ${item.author || 'Unknown'}\n- URL: ${item.url}\n- Video ID: ${item.videoId}\n- Published: ${formatDateYMD(item.publishedAt) || 'unknown'}\n\n`;
  await fs.writeFile(outPath, header + summary, 'utf8');
  return outPath;
}

async function fileExistsSafe(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function sleepSafe(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

function formatDateYMD(input) {
  if (!input) return null;
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
