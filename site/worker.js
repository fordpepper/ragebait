// Runs the model off the main thread so the chat stays smooth while Gus "types".
// transformers.js comes from the jsDelivr CDN (pinned); the wasm runtime and the model are served from this site.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';
import { makeVariety, buildMessages, tidy, looksBroken, GEN } from './persona.js';
import { MODEL } from './config.js';

const base = new URL('./', import.meta.url);
// Everything comes from this site: the model under ./models/, the wasm runtime under ./vendor/.
env.remoteHost = new URL('models/', base).href;
env.remotePathTemplate = '{model}/';
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL('vendor/', base).href;

// GitHub Pages can't hold files over 100 MB, so big model files are stored in parts.
// This fetch stitches them back into one streamed response (with a real length, for the progress bar).
const plainFetch = env.fetch;
const partsReady = plainFetch(new URL(`models/${MODEL.id}/parts.json`, base)).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
env.fetch = async (url, init = {}) => {
  const href = String(url);
  const prefix = new URL(`models/${MODEL.id}/`, base).href;
  const parts = href.startsWith(prefix) ? (await partsReady)[href.slice(prefix.length)] : null;
  if (!parts) return plainFetch(url, init);
  const headers = { 'content-length': String(parts.size), 'content-type': 'application/octet-stream' };
  if (new Headers(init.headers).has('range')) {
    return new Response(new Uint8Array(1), { status: 206, headers: { ...headers, 'content-length': '1', 'content-range': `bytes 0-0/${parts.size}` } });
  }
  let i = 0, reader = null;
  const body = new ReadableStream({
    async pull(ctrl) {
      for (;;) {
        if (!reader) {
          if (i >= parts.files.length) return ctrl.close();
          const res = await plainFetch(new URL(parts.files[i++], prefix));
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
};

let gen = null;
const variety = makeVariety();

async function load() {
  let device = 'wasm';
  try { if (await navigator.gpu?.requestAdapter()) device = 'webgpu'; } catch {}
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.total) {
      files.set(p.file, [p.loaded, p.total]);
      let loaded = 0, total = 0;
      for (const [l, t] of files.values()) { loaded += l; total += t; }
      postMessage({ type: 'progress', loaded, total });
    }
  };
  try {
    gen = await pipeline('text-generation', MODEL.id, { device, dtype: MODEL.dtype, progress_callback });
    await gen([{ role: 'user', content: 'hi' }], { max_new_tokens: 2 });
  } catch (e) {
    if (device === 'wasm') throw e;
    // Some GPUs advertise WebGPU but choke on it; the CPU path always works.
    device = 'wasm';
    gen = await pipeline('text-generation', MODEL.id, { device, dtype: MODEL.dtype, progress_callback });
    await gen([{ role: 'user', content: 'hi' }], { max_new_tokens: 2 });
  }
  postMessage({ type: 'ready', device });
}

async function reply(history, idle) {
  let best = '';
  for (let tries = 0; tries < 3; tries++) {
    const out = await gen(buildMessages(history, { idle }), GEN);
    const text = tidy(out[0].generated_text.at(-1).content);
    if (!best && !looksBroken(text)) best = text;
    if (!looksBroken(text) && !variety.isStale(text)) { best = text; break; }
  }
  if (!best) best = variety.fallback();
  variety.used(best);
  return best;
}

let queue = Promise.resolve();
onmessage = ({ data: msg }) => {
  if (msg.type === 'load') load().catch((err) => postMessage({ type: 'error', message: String(err?.message || err) }));
  if (msg.type === 'reply') {
    queue = queue.then(async () => {
      try { postMessage({ type: 'reply', id: msg.id, text: await reply(msg.history, msg.idle) }); }
      catch (err) { postMessage({ type: 'reply', id: msg.id, text: variety.fallback(), error: String(err?.message || err) }); }
    });
  }
};
