import fs from 'fs/promises';
import OpenAI from 'openai';

const DEFAULT_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

function buildPrompt({ userContext, videoMeta, transcriptSample }) {
  const sys = `You are a meticulous research assistant summarizing long video transcripts. Produce concise, well-structured Markdown with:
- Title
- Key Takeaways (5-10 bullets)
- Detailed Summary (sections with headings)
- Notable Quotes (attributed, if possible)
- Action Items / References

Be faithful to the source and avoid hallucinations.`;

  const userInst = `User context/instructions (optional):\n${userContext || '(none provided)'}\n\nVideo: ${videoMeta.title}\nChannel: ${videoMeta.author}\nURL: ${videoMeta.url}\n\nTranscript (may be partial or summarized in chunks):\n${transcriptSample}`;
  return { sys, user: userInst };
}

export async function summarizeTranscriptFull(transcriptText, videoMeta, { contextPath } = {}) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const userContext = contextPath ? await readOptional(contextPath) : '';

  // If transcript is very long, summarize in chunks then synthesize.
  const chunkSize = 9000; // characters per chunk (rough heuristic)
  const chunks = [];
  for (let i = 0; i < transcriptText.length; i += chunkSize) {
    chunks.push(transcriptText.slice(i, i + chunkSize));
  }

  const chunkSummaries = [];
  for (let idx = 0; idx < chunks.length; idx++) {
    const { sys, user } = buildPrompt({
      userContext,
      videoMeta,
      transcriptSample: `Chunk ${idx + 1}/${chunks.length}:\n` + chunks[idx],
    });
    const resp = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      temperature: 0.3,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
    });
    const text = resp.choices?.[0]?.message?.content?.trim() || '';
    chunkSummaries.push(text);
  }

  if (chunkSummaries.length === 1) {
    return chunkSummaries[0];
  }

  // Synthesize final
  const synthSys = 'You are combining multiple partial summaries into one cohesive, non-redundant Markdown summary. Preserve structure and accuracy.';
  const synthUser = `Combine the following ${chunkSummaries.length} chunk summaries into one clear Markdown summary following the user instructions and desired structure.\n\n${chunkSummaries.map((s, i) => `# Chunk ${i + 1}\n${s}`).join('\n\n')}`;
  const synth = await client.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.2,
    messages: [
      { role: 'system', content: synthSys },
      { role: 'user', content: synthUser },
    ],
  });
  return synth.choices?.[0]?.message?.content?.trim() || chunkSummaries.join('\n\n');
}

async function readOptional(p) {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return '';
  }
}

