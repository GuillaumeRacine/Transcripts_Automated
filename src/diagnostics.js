import './env.js';
import { normalizeNotionPageId } from './notion.js';

function check(name, present) {
  return `${present ? '✔' : '✖'} ${name}${present ? '' : ' (missing)'}`;
}

function main() {
  const openai = !!process.env.OPENAI_API_KEY;
  const yt = !!process.env.YOUTUBE_API_KEY;
  const notionTok = !!process.env.NOTION_TOKEN;
  const notionParentRaw = process.env.NOTION_PARENT_PAGE_ID || '';
  const notionParent = notionTok && notionParentRaw ? normalizeNotionPageId(notionParentRaw) : null;

  console.log('Environment check:');
  console.log(' ', check('OPENAI_API_KEY', openai));
  console.log(' ', check('YOUTUBE_API_KEY', yt));
  console.log(' ', check('NOTION_TOKEN', notionTok));
  console.log(' ', check('NOTION_PARENT_PAGE_ID', !!notionParentRaw));
  if (notionTok && notionParentRaw) {
    console.log('   Notion parent normalized ->', notionParent);
    if (!/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(notionParent)) {
      console.log('   Warning: NOTION_PARENT_PAGE_ID may be invalid. Provide a Notion page URL or UUID.');
    }
  }

  if (!openai || !yt) {
    process.exitCode = 1;
  }
}

main();
