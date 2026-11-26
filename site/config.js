// The model lives on this site under ./models/<id>/: a fine-tuned SmolLM2-360M "Gus" in 4-bit ONNX (see train/).
// Bump the id whenever the model changes: browsers cache model files by URL.
export const MODEL = {
  id: 'gus-v3',
  dtype: 'q4',
};

// Rough first-visit download in MB (model + tokenizer + wasm runtime, as sent over the wire). Shown on mobile data.
export const DOWNLOAD_MB = 225;
