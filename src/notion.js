import { Client } from '@notionhq/client';
import { chunkText } from './util.js';

export function normalizeNotionPageId(input) {
  if (!input) return input;
  const trimmed = String(input).trim();
  // If full URL, extract 32-hex id at the end
  const mUrl = trimmed.match(/[0-9a-fA-F]{32}(?=\b)/);
  const raw = mUrl ? mUrl[0] : trimmed.replace(/-/g, '');
  if (/^[0-9a-fA-F]{32}$/.test(raw)) {
    const s = raw.toLowerCase();
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }
  // If already hyphenated UUID, pass through
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return trimmed;
}

function markdownToBlocks(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let buffer = [];
  let inCode = false;
  let codeLang = '';
  let codeLines = [];
  let quoteLines = [];

  const flushParagraph = () => {
    if (!buffer.length) return;
    const text = buffer.join(' ').trim();
    if (!text) { buffer = []; return; }
    for (const ch of chunkText(text, 1800)) {
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: ch } }] },
      });
    }
    buffer = [];
  };

  const flushQuote = () => {
    if (!quoteLines.length) return;
    const text = quoteLines.join('\n');
    blocks.push({
      object: 'block',
      type: 'quote',
      quote: { rich_text: [{ type: 'text', text: { content: text.slice(0, 1900) } }] },
    });
    quoteLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimEnd();

    // Code blocks
    const codeMatch = /^```(.*)$/.exec(trimmed);
    if (codeMatch) {
      if (!inCode) {
        flushParagraph();
        flushQuote();
        inCode = true;
        codeLang = (codeMatch[1] || '').trim();
        codeLines = [];
      } else {
        // closing
        blocks.push({
          object: 'block',
          type: 'code',
          code: {
            language: (codeLang || 'plain_text'),
            rich_text: [{ type: 'text', text: { content: codeLines.join('\n').slice(0, 1900) } }],
          },
        });
        inCode = false;
        codeLang = '';
        codeLines = [];
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    // Divider
    if (/^\s*---\s*$/.test(trimmed)) {
      flushParagraph();
      flushQuote();
      blocks.push({ object: 'block', type: 'divider', divider: {} });
      continue;
    }

    // Heading
    const h = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (h) {
      flushParagraph();
      flushQuote();
      const level = h[1].length; const content = h[2].trim();
      const key = level === 1 ? 'heading_1' : level === 2 ? 'heading_2' : 'heading_3';
      blocks.push({
        object: 'block',
        type: key,
        [key]: { rich_text: [{ type: 'text', text: { content: content.slice(0, 1900) } }] },
      });
      continue;
    }

    // Quote
    const q = /^>\s?(.*)$/.exec(trimmed);
    if (q) {
      flushParagraph();
      quoteLines.push(q[1]);
      // continue accumulating
      continue;
    } else if (quoteLines.length && trimmed === '') {
      // blank line ends quote
      flushQuote();
      continue;
    }

    // Numbered list
    const ol = /^\s*\d+\.\s+(.*)$/.exec(trimmed);
    if (ol) {
      flushParagraph();
      flushQuote();
      blocks.push({
        object: 'block',
        type: 'numbered_list_item',
        numbered_list_item: { rich_text: [{ type: 'text', text: { content: ol[1].slice(0, 1900) } }] },
      });
      continue;
    }

    // Bulleted list
    const ul = /^\s*[-*+]\s+(.*)$/.exec(trimmed);
    if (ul) {
      flushParagraph();
      flushQuote();
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ type: 'text', text: { content: ul[1].slice(0, 1900) } }] },
      });
      continue;
    }

    // Blank line
    if (trimmed === '') {
      flushParagraph();
      flushQuote();
      continue;
    }

    // Paragraph content
    buffer.push(trimmed);
  }
  flushParagraph();
  flushQuote();

  return blocks.length ? blocks : [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: '' } }] } }];
}

export async function createNotionPage({ title, markdown, parentPageId, meta }) {
  const notion = new Client({ auth: process.env.NOTION_TOKEN });
  const contentBlocks = markdownToBlocks(markdown);

  const headerBlocks = [];
  if (meta) {
    const infoLines = [
      meta.channel ? `Channel: ${meta.channel}` : null,
      meta.url ? `URL: ${meta.url}` : null,
      meta.videoId ? `Video ID: ${meta.videoId}` : null,
      `Generated: ${new Date().toISOString()}`,
    ].filter(Boolean).join('\n');
    headerBlocks.push({
      object: 'block',
      type: 'callout',
      callout: {
        icon: { type: 'emoji', emoji: '🎥' },
        rich_text: [{ type: 'text', text: { content: infoLines.slice(0, 1900) } }],
      },
    });
    if (meta.url) {
      headerBlocks.push({ object: 'block', type: 'bookmark', bookmark: { url: meta.url } });
    }
  }

  const children = [...headerBlocks, ...contentBlocks].slice(0, 95); // Notion max children per create

  const page = await notion.pages.create({
    parent: { type: 'page_id', page_id: parentPageId },
    properties: {
      title: {
        title: [
          {
            type: 'text',
            text: { content: title.slice(0, 100) },
          },
        ],
      },
    },
    children,
  });

  return page;
}
