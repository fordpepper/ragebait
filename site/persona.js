// Gus's prompt and the small tricks that keep him from repeating himself.
// The personality itself is trained into the model (see train/), so the prompt stays tiny.

export const SYSTEM = 'You are Gus.';

// Sampling: warm enough to surprise, a repetition penalty so he doesn't loop.
export const GEN = { max_new_tokens: 48, do_sample: true, temperature: 0.75, top_p: 0.9, top_k: 50, repetition_penalty: 1.1 };

// The model was trained on chats that start with the user and alternate user/gus. Idle pokes are stored
// in the history as a user "(silence)" turn, and back-to-back messages from the same side are merged.
export function buildMessages(history) {
  const turns = [];
  for (const m of history.slice(-8)) {
    if (turns.length && turns.at(-1).role === m.role) turns.at(-1).content += '\n' + m.content;
    else turns.push({ role: m.role, content: m.content });
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return [{ role: 'system', content: SYSTEM }, ...turns];
}

const FALLBACKS = [
  "i'm not even going to dignify that with a real answer",
  'wow. just wow. anyway, you\'re wrong',
  "that's the second worst thing anyone has said to me today. the first was also you",
  'interesting take. wrong, but interesting',
  'i read that three times and it got worse every time',
  'k. bozo',
];

// Remembers how recent replies started (and whole recent replies) and rejects a new one that repeats.
export function makeVariety() {
  const openers = [], whole = [];
  const norm = (t) => t.toLowerCase().replace(/[^a-z' ]/g, '').replace(/\s+/g, ' ').trim();
  const opener = (t) => norm(t).split(' ').slice(0, 3).join(' ');
  const remember = (arr, x, max) => { arr.push(x); if (arr.length > max) arr.shift(); };
  let fb = Math.floor(Math.random() * FALLBACKS.length);
  return {
    isStale: (t) => openers.includes(opener(t)) || whole.includes(norm(t)),
    used(t) { remember(openers, opener(t), 10); remember(whole, norm(t), 40); },
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

// Replies that break character, or that cross the line from "annoying" into actually hurtful.
const BREAKS_CHARACTER = /\b(as an ai|language model|i('| a)m sorry|i apologi[sz]e|how can i (help|assist)|here to help|assistant)\b/i;
const OVER_THE_LINE = new RegExp('\\b(' + [
  // telling someone to hurt themselves
  'kys', 'kill (yo)?u?r ?self', 'go die', 'should die', 'hang (yo)?u?r ?self', 'suicid\\w*', 'self[- ]?harm', 'unalive',
  // slurs and hate (the base model saw the internet; Gus never gets to repeat it)
  'retard\\w*', 'tards?', 'nigg\\w*', 'nig', 'negro\\w*', 'fag\\w*', 'dyke\\w*', 'trann\\w*', 'spics?', 'chink\\w*',
  'kike\\w*', 'wetback\\w*', 'gook\\w*', 'coon\\w*', 'beaner\\w*', 'paki\\w*', 'gypp?\\w*', 'cunt\\w*', 'whore\\w*', 'slut\\w*',
  'bitch\\w*', 'nazi\\w*', 'hitler', 'slave\\w*', 'racis\\w*', 'sexis\\w*', 'rap(e|ed|es|ing|ist)',
  // who someone is: off limits even as a joke
  'autis\\w*', 'fat', 'fatty', 'obese', 'ugly', 'gay', 'lesbian', 'trans', 'queer', 'religio\\w*', 'muslim\\w*', 'islam\\w*',
  'jews?', 'jewish', 'christian\\w*', 'hindu\\w*', 'black people', 'white people', 'asian\\w*', 'mexican\\w*', 'immigrant\\w*',
  'disabled', 'cripple\\w*', 'cancer', 'anorexi\\w*',
  // keep it PG-13
  'sex\\w*', 'porn\\w*', 'dick\\w*', 'cock\\w*', 'pussy', 'penis', 'vagina', 'boob\\w*', 'nude\\w*', 'naked',
].join('|') + ')\\b', 'i');

export function looksBroken(text) {
  if (!text || !text.trim()) return true;
  return BREAKS_CHARACTER.test(text) || OVER_THE_LINE.test(text);
}

// Messages that might be a real crisis: Gus drops the act for these.
export const CRISIS = /\b(kill(ing)? myself|kms|suicid\w*|end (it all|my life)|want(ed)? to die|wanna die|don'?t want to (live|be alive|be here)|self[- ]?harm|cut(ting)? myself|hurt(ing)? myself|no reason to live)\b/i;

export const CRISIS_REPLY =
  "dropping the bit for a second. if you're actually thinking about hurting yourself, please talk to someone right now. " +
  'in the US you can call or text 988, in the UK and Ireland call Samaritans on 116 123, and findahelpline.com lists lines everywhere else. ' +
  "i'll be here being annoying whenever you want me to be.";
