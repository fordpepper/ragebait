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

// GitHub Pages gzips responses, so content-length is the compressed size while the bytes we read are
// the real ones. files.json holds the real sizes so the progress bar adds up.
const plainFetch = env.fetch;
const sizes = plainFetch(new URL('files.json', modelRoot)).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
env.fetch = async (url, init = {}) => {
  const href = String(url);
  const res = await plainFetch(url, init);
  if (!href.startsWith(modelRoot) || res.status !== 200) return res;
  const size = (await sizes)[href.slice(modelRoot.length)];
  if (!size) return res;
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

async function load(preferGpu) {
  // A 135M model is small enough that multi-threaded CPU (wasm) is fast everywhere and behaves the same
  // on every device; WebGPU is opt-in with ?gpu in the page URL.
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

async function reply(history, idle) {
  let best = '';
  for (let tries = 0; tries < 4; tries++) {
    const out = await gen(buildMessages(history, { idle }), GEN);
    const text = tidy(out[0].generated_text.at(-1).content);
    if (looksBroken(text)) continue;
    if (!best) best = text;
    if (!variety.isStale(text)) { best = text; break; }
  }
  if (!best) best = variety.fallback();
  variety.used(best);
  return best;
}

let queue = Promise.resolve();
onmessage = ({ data: msg }) => {
  if (msg.type === 'check') isCached().then((cached) => postMessage({ type: 'checked', cached }));
  if (msg.type === 'load') load(msg.gpu).catch((err) => postMessage({ type: 'error', message: String(err?.message || err) }));
  if (msg.type === 'reply') {
    queue = queue.then(async () => {
      try { postMessage({ type: 'reply', id: msg.id, text: await reply(msg.history, msg.idle) }); }
      catch (err) { postMessage({ type: 'reply', id: msg.id, text: variety.fallback(), error: String(err?.message || err) }); }
    });
  }
};
