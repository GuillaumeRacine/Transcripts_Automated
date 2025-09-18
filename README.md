**Overview**
- Scans YouTube playlists from a `.md` file.
- Detects new videos, fetches transcripts, summarizes via LLM.
- Writes Markdown summaries and optionally publishes to Notion.
- Loads secrets from `.env.local`.

**Setup**
- `cp .env.local.example .env.local` and fill in (the app always loads `.env.local` first; it only falls back to `.env` if `.env.local` is missing — do not commit `.env.local`):
  - `OPENAI_API_KEY`
  - `LLM_MODEL` (optional, default `gpt-4o-mini`)
  - `NOTION_TOKEN` and `NOTION_PARENT_PAGE_ID` (optional, enable Notion publishing)
    - `NOTION_PARENT_PAGE_ID` can be either the page URL or its 32-hex/UUID ID; the app normalizes it.
  - `YOUTUBE_API_KEY` (required for YouTube Data API v3)
  - `USER_CONTEXT_PATH` (optional, path to a Markdown file with your instructions)
- `npm install`

**Environment**
- Loads environment from `.env.local` first, falling back to `.env` only if `.env.local` is missing.
- Required keys: `OPENAI_API_KEY`, `YOUTUBE_API_KEY`. Optional: `LLM_MODEL`, `NOTION_TOKEN`, `NOTION_PARENT_PAGE_ID`, `USER_CONTEXT_PATH`, `POLL_INTERVAL_MINUTES`.
- Do not commit `.env.local` or `data/state.json`. Outputs are written to `output/`.

**Playlists File**
- Create `playlists.md` with one or more YouTube playlist URLs anywhere in the file, e.g.:

  - https://www.youtube.com/playlist?list=PLxxxxxxxxxxxxxxxx
  - https://www.youtube.com/playlist?list=PLyyyyyyyyyyyyyyyy

The app extracts any `youtube.com/playlist?list=...` URLs it finds.

**Run**
- One-off scan: `node src/index.js --playlists playlists.md`
- Watch mode: `node src/index.js --watch --interval 60 --playlists playlists.md`
- Or use the bin: `yt-summarizer --playlists playlists.md` (after `npm link`)
- Dry run (no OpenAI/Notion calls): `node src/index.js --dry-run --playlists playlists.md`
- Single video: `node src/index.js --video https://www.youtube.com/watch?v=VIDEO_ID`
- Skip Notion creation: add `--no-notion`
- Summarize only first N chars (for quick tests): add `--sample 1500`
 - Process only a few items from playlists: add `--limit 1`
 - Minimum video length filter (playlists): `--min-minutes 25` (default 25). Env override: `MIN_VIDEO_MINUTES=25`.
   - Single video also respects this as a warning gate; override with `--ignore-min-duration` to force processing.

Outputs are saved to `output/` and processed IDs tracked in `data/state.json`.

**Notes**
- YouTube API: Uses Data API v3 `playlistItems.list`. Playlists must be public/unlisted.
- Transcripts: Uses `youtube-transcript` and may skip videos without transcripts.
- Notion: Creates a callout with video info, a bookmark for the URL, and converts Markdown to headings (H1–H3), bullets, numbered lists, quotes, code blocks, dividers, and paragraphs.
- Rate limits: Summarization chunks large transcripts before synthesizing.
 - Notion access: Share the parent page with your integration (via the Share menu) so it can create child pages.
 - Filtering: Playlist scans fetch durations and skip videos shorter than the configured minimum. Items with unknown duration are kept.
