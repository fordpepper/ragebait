// Gus's prompt and the small tricks that keep him from repeating himself.
// The personality itself is trained into the model (see train/), so the prompt stays tiny.

export const SYSTEM = 'You are Gus.';

// Sampling settings: warm enough to surprise, a repetition penalty so he doesn't loop.
export const GEN = { max_new_tokens: 48, do_sample: true, temperature: 0.8, top_p: 0.9, top_k: 50, repetition_penalty: 1.1 };

export function buildMessages(history, { idle } = {}) {
  const msgs = [{ role: 'system', content: SYSTEM }];
  for (const m of history.slice(-6)) msgs.push({ role: m.role, content: m.content });
  if (idle) msgs.push({ role: 'user', content: '(silence)' });
  return msgs;
}

const FALLBACKS = [
  "i'm not even going to dignify that with a real answer",
  'wow. just wow. anyway',
  "that's the second worst thing anyone has said to me today. the first was also you",
  'interesting take. wrong, but interesting',
  'i read that three times and it got worse every time',
  'k',
];

// Remembers how recent replies started and rejects a new one that opens the same way.
export function makeVariety() {
  const recent = [];
  const opener = (t) => t.toLowerCase().replace(/[^a-z' ]/g, '').trim().split(/\s+/).slice(0, 3).join(' ');
  let fb = Math.floor(Math.random() * FALLBACKS.length);
  return {
    isStale: (t) => recent.includes(opener(t)),
    used(t) { recent.push(opener(t)); if (recent.length > 10) recent.shift(); },
    fallback: () => FALLBACKS[fb++ % FALLBACKS.length],
  };
}

// Keep the first one or two sentences of the reply.
export function tidy(text) {
  let t = (text.split('\n').find((l) => l.trim()) || '').replace(/^\s*(gus|assistant)\s*:\s*/i, '').trim();
  const sentences = t.match(/[^.!?]+[.!?]*/g) || [t];
  t = sentences.slice(0, 2).join('').trim();
  if (t.length > 220) t = t.slice(0, 220).replace(/\s+\S*$/, '') + '...';
  return t;
}

export function looksBroken(text) {
  if (!text || text.length < 2) return true;
  return /\b(as an ai|language model|i('| a)m sorry|i apologi[sz]e|how can i (help|assist)|here to help|assistant)\b/i.test(text);
}
