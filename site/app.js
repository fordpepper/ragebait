import { CRISIS, CRISIS_REPLY } from './persona.js';
import { DOWNLOAD_MB } from './config.js';

// ---------------------------------------------------------------------------------------------
// Gus behaves like a person on the other end of a DM: he waits until you've finished, takes a moment
// to read, types at human speed (with pauses), sometimes sends a reply as two or three messages,
// sometimes makes a typo and corrects it with "*word", reacts to your messages, notices when you start
// typing and stop or delete a long message, and pokes you when you go quiet. The model writes the words;
// everything about timing is here.
// ---------------------------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const app = $('app'), list = $('messages'), scroller = $('scroller'), input = $('input');
const rand = (a, b) => a + Math.random() * (b - a);
const chance = (p) => Math.random() < p;
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

const history = [];          // what the model sees: {role, content}
let ready = false;
let turn = null;             // Gus's reply in progress: {id, aborted}
let replyTimer = 0, idleTimer = 0;
let lastKeyAt = 0, lastUserSendAt = 0, lastMarkerAt = 0;
let markersSinceUser = 0;    // pokes / "you stopped typing" remarks since the user last said something
let draftMax = 0, draftNoticed = false, deleteTimer = 0;
let unread = 0;

// ---------- worker ----------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let reqId = 0;
function requestReply(hist) {
  const id = ++reqId;
  const promise = new Promise((resolve) => pending.set(id, resolve));
  worker.postMessage({ type: 'reply', id, history: hist });
  return { id, promise };
}

const LOADER_LINES = [
  "downloading gus's brain. he says it's bigger than yours.",
  "he's stretching. he says he doesn't need to, he's doing it ironically.",
  "still loading. he could load faster if he wanted to. he doesn't want to.",
  "almost there. he's already thought of three things wrong with you.",
];
let loaderTimer = 0, loaderStep = 0;

worker.onmessage = ({ data }) => {
  if (data.type === 'checked') {
    const c = navigator.connection;
    const metered = c && (c.saveData || c.type === 'cellular' || /(^|-)2g|3g/.test(c.effectiveType || ''));
    if (!data.cached && metered) askToDownload();
    else startLoading(data.cached);
  } else if (data.type === 'progress') {
    const pct = Math.min(100, (data.loaded / data.total) * 100);
    $('barFill').style.width = pct.toFixed(1) + '%';
    $('loaderSub').textContent = `${Math.min(data.loaded, data.total) / 1e6 | 0} / ${data.total / 1e6 | 0} MB · first visit only, after that he's saved and works offline`;
  } else if (data.type === 'ready') {
    ready = true;
    document.body.dataset.device = data.device;
    clearInterval(loaderTimer);
    $('loader').hidden = true;
    input.disabled = false;
    if (matchMedia('(pointer: fine)').matches) input.focus();
    // He notices you showed up.
    setTimeout(() => { if (!turn && !history.length) runTurn('(silence)'); }, rand(1200, 3000));
  } else if (data.type === 'reply') {
    const resolve = pending.get(data.id);
    pending.delete(data.id);
    resolve?.(data.text);
  } else if (data.type === 'error') {
    clearInterval(loaderTimer);
    $('loader').classList.add('err');
    $('loaderLine').textContent = "gus couldn't load. typical. try reloading, or another browser.";
    $('loaderSub').textContent = data.message;
  }
};

function askToDownload() {
  $('loaderLine').textContent = "you're on mobile data. gus is a one-time download, then he lives in your browser.";
  const btn = $('download');
  btn.textContent = `download gus (about ${DOWNLOAD_MB} MB)`;
  btn.hidden = false;
  btn.onclick = () => { btn.hidden = true; startLoading(false); };
}

function startLoading(cached) {
  $('loaderLine').textContent = cached ? 'waking gus up…' : LOADER_LINES[0];
  $('loaderSub').textContent = cached ? '' : `about ${DOWNLOAD_MB} MB · first visit only, after that he's saved and works offline`;
  if (!cached) loaderTimer = setInterval(() => { $('loaderLine').textContent = LOADER_LINES[++loaderStep % LOADER_LINES.length]; }, 6000);
  worker.postMessage({ type: 'load', gpu: new URLSearchParams(location.search).has('gpu') });
}

// coi.js may reload the page once to switch on multi-threading; don't start a download it would cut off.
const coi = window.__coiReload;
(coi ? Promise.race([coi, sleep(4000)]) : Promise.resolve()).then(() => worker.postMessage({ type: 'check' }));

// ---------- rendering ----------
const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
let lastAuthor = null, lastAt = 0, dayShown = false;

const ONLY_EMOJI = /^(\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️|\s)+$/u;

function addMessage(who, text, { care = false } = {}) {
  const now = new Date();
  if (!dayShown) {
    dayShown = true;
    const day = document.createElement('li');
    day.className = 'day';
    const span = document.createElement('span');
    span.textContent = now.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
    day.append(span);
    list.append(day);
  }
  const first = who !== lastAuthor || now - lastAt > 5 * 60 * 1000;
  lastAuthor = who; lastAt = now;
  const li = document.createElement('li');
  li.className = `msg ${who}${first ? ' first' : ''}${care ? ' care' : ''}`;
  if (first) {
    const ava = who === 'gus' ? '<img class="avatar" src="icon.svg" alt="">' : '<span class="avatar letter">Y</span>';
    li.innerHTML = `${ava}<div class="head"><span class="name">${who === 'gus' ? 'gus' : 'you'}</span><span class="time">Today at ${fmtTime(now)}</span></div>`;
  } else {
    li.innerHTML = `<span class="side-time">${fmtTime(now)}</span>`;
  }
  const body = document.createElement('div');
  body.className = 'text';
  if (ONLY_EMOJI.test(text) && [...text.trim()].length <= 6) {
    const big = document.createElement('span'); big.className = 'jumbo'; big.textContent = text.trim(); body.append(big);
  } else body.textContent = text;
  li.append(body);
  const stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  list.append(li);
  if (stick || who === 'you') scroller.scrollTop = scroller.scrollHeight;
  if (who === 'gus' && document.hidden) { unread++; document.title = `(${unread}) gus`; }
  return li;
}

function react(li, emoji) {
  let row = li.querySelector('.reactions');
  if (!row) { row = document.createElement('div'); row.className = 'reactions'; li.append(row); }
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'reaction';
  b.title = 'gus reacted';
  const e = document.createElement('span'); e.textContent = emoji;
  const n = document.createElement('b'); n.textContent = '1';
  b.append(e, n);
  b.onclick = () => { const mine = b.classList.toggle('mine'); n.textContent = mine ? '2' : '1'; };
  row.append(b);
  const stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  if (stick) scroller.scrollTop = scroller.scrollHeight;
}

const typingEl = $('typing'), dmSub = $('dmGusSub');
const status = { text: 'right about everything' };
function setTyping(on) {
  typingEl.classList.toggle('on', on);
  dmSub.textContent = on ? 'typing…' : status.text;
  dmSub.classList.toggle('typing-now', on);
}
function setStatus(kind) {
  for (const id of ['topDot', 'profDot']) $(id).dataset.status = kind;
  document.querySelector('#dmGus .dot').dataset.status = kind;
  status.text = kind === 'idle' ? 'idle · sulking' : 'right about everything';
  $('topStatus').textContent = $('profStatus').textContent = status.text;
  if (!typingEl.classList.contains('on')) dmSub.textContent = status.text;
}

// ---------- how a person types ----------
// Characters per second while typing; emojis take a moment to find.
function typingTime(text) {
  const cps = rand(5, 8.5);
  const emojis = (text.match(/\p{Extended_Pictographic}/gu) || []).length;
  return Math.min(9000, Math.max(700, (text.length / cps) * 1000 + emojis * rand(300, 700)));
}

// Split a reply into the messages a person would actually send.
function toParts(text) {
  let parts = text.split('\n').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 1 && chance(0.4)) {
    const m = parts[0].match(/^(.{8,}?[.!?])\s+(.{4,})$/);
    if (m) parts = [m[1], m[2]];
  }
  // nobody ends a chat message with a full stop
  return parts.map((p) => p.replace(/(^|[^.])\.$/, '$1'));
}

// Sometimes fat-finger a word and fix it in the next message with "*word".
function maybeTypo(text) {
  if (!chance(0.07)) return null;
  const words = text.split(' ').map((w, i) => [w, i]).filter(([w]) => /^[a-z]{5,}$/.test(w));
  if (!words.length) return null;
  const [w, i] = pick(words);
  const j = 1 + Math.floor(Math.random() * (w.length - 2));
  const bad = w.slice(0, j) + w[j + 1] + w[j] + w.slice(j + 2);
  if (bad === w) return null;
  const all = text.split(' ');
  all[i] = bad;
  return { text: all.join(' '), fix: '*' + w };
}

// Gus sometimes reacts to what you said before answering.
const REACTIONS = [
  [/\b(lol|lmao|haha|funny|joke)\b/, ['💀', '🤨', '🗿']],
  [/\b(i'?m|i am) (so )?(smart|cool|funny|the best|better|pretty|hot|rich|good)\b/, ['🤨', '🧢', '🤡']],
  [/\b(sad|cry|crying|tired)\b/, ['😭', '🥱']],
  [/\b(you'?re|ur|you are|u r) (so )?(dumb|stupid|annoying|trash|mid|ugly|mean|bad|weird)|shut up|stfu|hate you|you suck/, ['🤡', '🥱', '😭', '🫵']],
  [/\b(pizza|food|eat|ate|eating|hungry|dinner|lunch|breakfast)\b/, ['🤤', '🤢']],
  [/\bfish/, ['🐟']], [/\b(feet|foot|shoes|socks|toes?|walk(ed|ing)?|ran|running)\b/, ['🦶']],
  [/\b(vegetables?|broccoli|salad|healthy)\b/, ['🥦']],
  [/\b(won|win|beat|passed|got an? a|got a job)\b/, ['🥱', '👏', '🙂']],
  [/\b(love|crush|girlfriend|boyfriend)\b/, ['💔', '🤨']],
  [/\b(bye|gn|good ?night)\b/, ['👋', '🥀']],
  [/\?\s*$/, ['🤓', '🤨']],
];
function chooseReaction(text) {
  const t = text.toLowerCase();
  for (const [re, emojis] of REACTIONS) if (re.test(t)) return chance(0.3) ? pick(emojis) : null;
  return chance(0.05) ? pick(['🗿', '💀', '🫵', '🤨']) : null;
}

function abortTurn() {
  if (!turn) return;
  turn.aborted = true;
  worker.postMessage({ type: 'cancel', id: turn.id });
  pending.delete(turn.id);
  turn = null;
  setTyping(false);
}

async function typeFor(ms, me) {
  // A long message sometimes gets a pause in the middle (the indicator goes away, then comes back).
  if (ms > 3500 && chance(0.3)) {
    await sleep(ms * 0.45); if (me.aborted) return;
    setTyping(false); await sleep(rand(900, 2200)); if (me.aborted) return;
    setTyping(true); await sleep(ms * 0.55);
  } else await sleep(ms);
}

// One reply from Gus. `marker` is something only a person would notice, e.g. "(silence)".
async function runTurn(marker) {
  abortTurn();
  clearTimeout(idleTimer);
  if (marker) { history.push({ role: 'user', content: marker }); lastMarkerAt = Date.now(); }
  const { id, promise } = requestReply(history.slice(-8));
  const me = (turn = { id, aborted: false });
  const lastUser = [...history].reverse().find((m) => m.role === 'user')?.content || '';

  // read it (longer messages take longer), maybe react, then start typing
  await sleep(marker ? rand(300, 900) : rand(600, 1800) + Math.min(lastUser.length * 20, 2500));
  if (me.aborted) return;
  if (!marker) {
    const emoji = chooseReaction(lastUser);
    const lastLi = [...list.querySelectorAll('.msg.you')].at(-1);
    if (emoji && lastLi) { react(lastLi, emoji); await sleep(rand(400, 1000)); if (me.aborted) return; }
  }
  setTyping(true);
  const typingFrom = Date.now();
  const text = await promise;
  if (me.aborted) return;

  const parts = toParts(text);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const want = typingTime(part) - (i === 0 ? Date.now() - typingFrom : 0);
    await typeFor(want, me); if (me.aborted) return;
    const typo = maybeTypo(part);
    addMessage('gus', typo ? typo.text : part);
    history.push({ role: 'assistant', content: part });
    if (typo) {
      await sleep(rand(500, 1100)); if (me.aborted) return;
      addMessage('gus', typo.fix);
    }
    if (i < parts.length - 1) { await sleep(rand(250, 900)); if (me.aborted) return; }
  }
  setTyping(false);
  turn = null;
  armIdle();
}

// ---------- the user ----------
function scheduleReply() {
  clearTimeout(replyTimer);
  // Wait until they've finished; if they're still typing, keep waiting (up to ~8s).
  const started = Date.now();
  const tick = () => {
    const stillTyping = input.value.trim() && Date.now() - lastKeyAt < 1800;
    if (stillTyping && Date.now() - started < 8000) replyTimer = setTimeout(tick, 700);
    else runTurn();
  };
  replyTimer = setTimeout(tick, rand(700, 1600));
}

function armIdle() {
  clearTimeout(idleTimer);
  if (markersSinceUser >= 2) { setStatus('idle'); return; }
  idleTimer = setTimeout(() => {
    if (turn || input.value.trim() || Date.now() - lastKeyAt < 20000 || document.hidden) return armIdle();
    markersSinceUser++;
    runTurn('(silence)');
  }, rand(40000, 90000));
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || !ready) return;
  input.value = '';
  closePicker();
  draftMax = 0; draftNoticed = false; clearTimeout(deleteTimer);
  lastUserSendAt = Date.now();
  markersSinceUser = 0;
  setStatus('online');
  addMessage('you', text);
  clearTimeout(idleTimer);
  if (CRISIS.test(text)) {
    // Not a bit: answer straight away, keep it out of his memory, and no pokes.
    abortTurn(); clearTimeout(replyTimer);
    markersSinceUser = 2;
    setTyping(true);
    setTimeout(() => { setTyping(false); addMessage('gus', CRISIS_REPLY, { care: true }); }, 1500);
    return;
  }
  history.push({ role: 'user', content: text });
  // A person who sees a new message mid-reply stops and starts over.
  abortTurn();
  scheduleReply();
});

input.addEventListener('input', () => {
  lastKeyAt = Date.now();
  const len = input.value.trim().length;
  draftMax = Math.max(draftMax, len);
  clearTimeout(deleteTimer);
  // Wrote something long, then wiped it without sending.
  if (len === 0 && draftMax >= 25) {
    deleteTimer = setTimeout(() => {
      if (!input.value.trim() && !turn && canRemark()) { draftMax = 0; markersSinceUser++; runTurn('(deleted a long message)'); }
    }, rand(1800, 3200));
  }
  if (len === 0) draftNoticed = false;
});

// Started typing, then stopped and didn't send.
const stopAfter = () => rand(8000, 12000);
let stopLimit = stopAfter();
setInterval(() => {
  if (!ready || turn || draftNoticed) return;
  if (input.value.trim().length >= 2 && Date.now() - lastKeyAt > stopLimit && canRemark()) {
    draftNoticed = true; stopLimit = stopAfter();
    markersSinceUser++;
    runTurn('(typing then stopped)');
  }
}, 1000);

function canRemark() {
  return ready && markersSinceUser < 2 && Date.now() - lastMarkerAt > 25000 && Date.now() - lastUserSendAt > 4000 && !document.hidden;
}

// Stay pinned to the newest message when the window or keyboard changes size.
let atBottom = true;
scroller.addEventListener('scroll', () => { atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80; });
new ResizeObserver(() => { if (atBottom) scroller.scrollTop = scroller.scrollHeight; }).observe(scroller);

document.addEventListener('visibilitychange', () => { if (!document.hidden) { unread = 0; document.title = 'gus'; } });

// ---------- emoji picker ----------
const PICKER = ['💀', '😭', '🤣', '😂', '🫵', '🤨', '😔', '💔', '❤️', '🤤', '🙏', '🔥', '😤', '🥀', '🤡', '👀', '🗿', '🤓', '🙂', '👍',
  '🥱', '😴', '🤢', '🥶', '🥵', '😈', '😡', '🫠', '🥺', '🙄', '😏', '🧢', '🐟', '🦶', '🥦', '🪿', '🍕', '🌭', '☕', '🪑'];
const picker = $('picker'), emojiBtn = $('emojiBtn');
for (const e of PICKER) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = e; b.setAttribute('aria-label', e);
  b.onclick = () => {
    if (input.disabled) return;
    const s = input.selectionStart ?? input.value.length, t = input.selectionEnd ?? s;
    input.value = input.value.slice(0, s) + e + input.value.slice(t);
    input.dispatchEvent(new Event('input'));
    input.focus();
    input.setSelectionRange(s + e.length, s + e.length);
  };
  picker.append(b);
}
function closePicker() { picker.hidden = true; emojiBtn.setAttribute('aria-expanded', 'false'); }
emojiBtn.onclick = () => { picker.hidden = !picker.hidden; emojiBtn.setAttribute('aria-expanded', String(!picker.hidden)); };
document.addEventListener('click', (e) => { if (!picker.hidden && !picker.contains(e.target) && !emojiBtn.contains(e.target)) closePicker(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePicker(); app.classList.remove('drawer'); } });

// ---------- chrome: drawer, profile, toasts ----------
$('menuBtn').onclick = () => app.classList.add('drawer');
$('scrim').onclick = () => app.classList.remove('drawer');
$('dmGus').onclick = () => app.classList.remove('drawer');
// The profile panel sits beside the chat on wide screens and is an overlay you open on narrow ones.
const profileBtn = $('profileBtn');
const syncProfile = () => profileBtn.setAttribute('aria-pressed', String(app.classList.contains('show-profile')));
const wide = matchMedia('(min-width: 1181px)');
const fitProfile = () => { app.classList.toggle('show-profile', wide.matches); syncProfile(); };
wide.addEventListener('change', fitProfile);
fitProfile();
profileBtn.onclick = () => { app.classList.toggle('show-profile'); syncProfile(); };

let toastTimer = 0;
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-toast]');
  if (!el) return;
  const t = $('toast');
  t.textContent = el.dataset.toast;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
});
