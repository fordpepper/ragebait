import { CRISIS, CRISIS_REPLY } from './persona.js';
import { DOWNLOAD_MB } from './config.js';

const $ = (id) => document.getElementById(id);
const chat = $('chat'), input = $('input'), send = $('send'), status = $('status');
const history = [];
let pending = 0, nextId = 1, idleTimer = 0, idlePokes = 0, ready = false;

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

const LOADER_LINES = [
  "downloading gus's brain. it's small. like, really small.",
  "he's stretching. he says he doesn't need to, he's just doing it ironically.",
  'still loading. he wants you to know he could load faster if he wanted to.',
  "almost there. he's already thought of three things wrong with you.",
];
const STATUSES = ['online, unfortunately', 'online and correct', 'right about everything', 'ignoring you (not really)', 'online. obviously.', 'judging you'];
let loaderStep = 0, loaderTimer = 0;

worker.onmessage = ({ data }) => {
  if (data.type === 'checked') {
    // On mobile data or data saver, ask before the one-time download.
    const c = navigator.connection;
    const metered = c && (c.saveData || c.type === 'cellular' || /(^|-)2g|3g/.test(c.effectiveType || ''));
    if (!data.cached && metered) askToDownload();
    else startLoading();
  } else if (data.type === 'progress') {
    const pct = Math.min(100, (data.loaded / data.total) * 100);
    $('barFill').style.width = pct.toFixed(1) + '%';
    $('loaderSub').textContent = `${Math.min(data.loaded, data.total) / 1e6 | 0} / ${data.total / 1e6 | 0} MB. first visit only, after that he's saved and works offline.`;
  } else if (data.type === 'ready') {
    ready = true;
    document.body.dataset.device = data.device;   // webgpu or wasm, handy when debugging
    clearInterval(loaderTimer);
    $('loader').hidden = true;
    chat.hidden = false;
    input.disabled = send.disabled = false;
    setStatus();
    input.focus();
    ask({ idle: true });
  } else if (data.type === 'reply') {
    pending--;
    removeTyping();
    addMsg('gus', data.text);
    history.push({ role: 'assistant', content: data.text });
    setStatus();
    armIdle();
  } else if (data.type === 'error') {
    clearInterval(loaderTimer);
    $('loader').classList.add('err');
    $('loaderLine').textContent = "gus couldn't load. typical. (try reloading, or another browser)";
    $('loaderSub').textContent = data.message;
  }
};

function askToDownload() {
  $('loaderLine').textContent = "you're on mobile data. gus is a one-time download, then he lives in your browser.";
  $('loaderSub').textContent = '';
  const btn = $('download');
  btn.textContent = `download gus (about ${DOWNLOAD_MB} MB)`;
  btn.hidden = false;
  btn.onclick = () => { btn.hidden = true; startLoading(); };
}

function startLoading() {
  $('loaderLine').textContent = LOADER_LINES[0];
  $('loaderSub').textContent = `about ${DOWNLOAD_MB} MB, first visit only. after that he's saved and works offline.`;
  loaderTimer = setInterval(() => { $('loaderLine').textContent = LOADER_LINES[++loaderStep % LOADER_LINES.length]; }, 5000);
  worker.postMessage({ type: 'load', gpu: new URLSearchParams(location.search).has('gpu') });
}

chat.hidden = true;
// coi.js may be about to reload the page once to switch on multi-threading; don't start a download it would cut off.
const coi = window.__coiReload;
(coi ? Promise.race([coi, new Promise((r) => setTimeout(r, 4000))]) : Promise.resolve())
  .then(() => worker.postMessage({ type: 'check' }));

function setStatus() {
  status.classList.toggle('typing', pending > 0);
  status.textContent = pending > 0 ? 'typing…' : STATUSES[Math.floor(Math.random() * STATUSES.length)];
}

function addMsg(who, text) {
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  el.textContent = text;
  chat.append(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

function showTyping() {
  if (chat.querySelector('.typing-bubble')) return;
  const el = document.createElement('div');
  el.className = 'msg gus typing-bubble';
  el.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
  chat.append(el);
  chat.scrollTop = chat.scrollHeight;
}
function removeTyping() { chat.querySelector('.typing-bubble')?.remove(); }

function ask({ idle = false } = {}) {
  pending++;
  // A short "read it, sigh, start typing" pause feels more human (and more annoying).
  setTimeout(() => { if (pending) { showTyping(); setStatus(); } }, 400 + Math.random() * 900);
  worker.postMessage({ type: 'reply', id: nextId++, history: history.slice(-6), idle });
}

// Go quiet and he pokes you, a couple of times, then sulks until you talk again.
function armIdle() {
  clearTimeout(idleTimer);
  if (idlePokes >= 2) return;
  idleTimer = setTimeout(() => {
    if (pending || document.hidden) return armIdle();
    idlePokes++;
    ask({ idle: true });
  }, 35000 + Math.random() * 40000);
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || !ready) return;
  input.value = '';
  addMsg('me', text);
  clearTimeout(idleTimer);
  if (CRISIS.test(text)) {
    // Not a bit. Answer straight, keep it out of his memory, and no pokes.
    addMsg('gus care', CRISIS_REPLY);
    idlePokes = 2;
    return;
  }
  history.push({ role: 'user', content: text });
  idlePokes = 0;
  ask();
});
