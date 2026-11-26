// Runs the model off the main thread so the chat stays smooth while Gus "types".
// transformers.js comes from the jsDelivr CDN (pinned); the wasm runtime and the model are served from this site.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';
import { makeVariety, buildMessages, tidy, looksBroken, GEN } from './persona.js';
import { MODEL } from './config.js';

const base = new URL('./', import.meta.url);
const modelRoot = new URL(`models/${MODEL.id}/`, base).href;
env.remoteHost = new URL('models/', base).href;
env.remotePathTemplate = '{model}/';
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL('vendor/', base).href;

// files.json (written by train/export.py) lists the real size of every model file, and the parts of
// any file over GitHub's 100 MB limit. GitHub Pages gzips responses, so content-length is the compressed
// size while the bytes we read are the real ones; the sizes make the progress bar add up, and big files
// are streamed back together from their parts.
const plainFetch = env.fetch;
const manifest = plainFetch(new URL('files.json', modelRoot)).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
env.fetch = async (url, init = {}) => {
  const href = String(url);
  if (!href.startsWith(modelRoot)) return plainFetch(url, init);
  const rel = href.slice(modelRoot.length);
  const { files = {}, parts = {} } = await manifest;
  const size = files[rel];
  const ranged = new Headers(init.headers).has('range');
  if (parts[rel]) {
    const headers = { 'content-length': String(size), 'content-type': 'application/octet-stream' };
    if (ranged) return new Response(new Uint8Array(1), { status: 206, headers: { ...headers, 'content-length': '1', 'content-range': `bytes 0-0/${size}` } });
    let i = 0, reader = null;
    const body = new ReadableStream({
      async pull(ctrl) {
        for (;;) {
          if (!reader) {
            if (i >= parts[rel].length) return ctrl.close();
            const res = await plainFetch(new URL(parts[rel][i++], modelRoot));
            if (!res.ok) throw new Error(`model part ${i} failed: ${res.status}`);
            reader = res.body.getReader();
          }
          const { done, value } = await reader.read();
          if (done) { reader = null; continue; }
          return ctrl.enqueue(value);
        }
      },
    });
    return new Response(body, { status: 200, headers });
  }
  const res = await plainFetch(url, init);
  if (res.status !== 200 || !size) return res;
  const headers = new Headers(res.headers);
  headers.set('content-length', String(size));
  headers.delete('content-encoding');
  return new Response(res.body, { status: 200, statusText: res.statusText, headers });
};

async function isCached() {
  try {
    const cache = await caches.open(env.cacheKey);
    return !!(await cache.match(new URL(`onnx/model_${MODEL.dtype}.onnx`, modelRoot).href));
  } catch { return false; }
}

let gen = null;
const variety = makeVariety();

// Drop older versions of the model from the browser's cache so they don't sit there taking up space.
async function forgetOldModels() {
  try {
    const cache = await caches.open(env.cacheKey);
    for (const req of await cache.keys()) {
      if (req.url.startsWith(env.remoteHost) && !req.url.startsWith(modelRoot)) await cache.delete(req);
    }
  } catch {}
}

async function load(preferGpu) {
  await forgetOldModels();
  // Multi-threaded CPU (wasm) behaves the same on every device and is quick enough that a reply is ready
  // well before a human would have typed it; WebGPU is opt-in with ?gpu in the page URL.
  let device = 'wasm';
  if (preferGpu) try { if (await navigator.gpu?.requestAdapter()) device = 'webgpu'; } catch {}
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.total) {
      files.set(p.file, [p.loaded, p.total]);
      let loaded = 0, total = 0;
      for (const [l, t] of files.values()) { loaded += l; total += t; }
      postMessage({ type: 'progress', loaded, total });
    }
  };
  const start = async () => {
    gen = await pipeline('text-generation', MODEL.id, { device, dtype: MODEL.dtype, progress_callback });
    await gen([{ role: 'user', content: 'hi' }], { max_new_tokens: 2 });
  };
  try {
    await start();
  } catch (e) {
    if (device === 'wasm') throw e;
    // Some GPUs advertise WebGPU but choke on it; the CPU path always works.
    device = 'wasm';
    await start();
  }
  postMessage({ type: 'ready', device });
}

async function reply(history) {
  let best = '';
  for (let tries = 0; tries < 4; tries++) {
    const out = await gen(buildMessages(history), GEN);
    const text = tidy(out[0].generated_text.at(-1).content);
    if (looksBroken(text)) continue;
    if (!best) best = text;
    if (!variety.isStale(text)) { best = text; break; }
  }
  if (!best) best = variety.fallback();
  variety.used(best);
  return best;
}

// Replies run one at a time. The page cancels a request when the user says something new before Gus
// "sends" (a person would start over too), so queued work for it is skipped.
let queue = Promise.resolve();
const cancelled = new Set();
onmessage = ({ data: msg }) => {
  if (msg.type === 'check') isCached().then((cached) => postMessage({ type: 'checked', cached }));
  if (msg.type === 'load') load(msg.gpu).catch((err) => postMessage({ type: 'error', message: String(err?.message || err) }));
  if (msg.type === 'cancel') cancelled.add(msg.id);
  if (msg.type === 'reply') {
    queue = queue.then(async () => {
      if (cancelled.delete(msg.id)) return;
      try { postMessage({ type: 'reply', id: msg.id, text: await reply(msg.history) }); }
      catch (err) { postMessage({ type: 'reply', id: msg.id, text: variety.fallback(), error: String(err?.message || err) }); }
    });
  }
};
