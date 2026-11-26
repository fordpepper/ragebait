// The model lives on this site under ./models/<id>/: a fine-tuned SmolLM2-135M "Gus" in 4-bit ONNX (see train/).
export const MODEL = {
  id: 'gus',
  dtype: 'q4',
};

// Rough first-visit download in MB (model + tokenizer + wasm runtime, as sent over the wire). Shown on mobile data.
export const DOWNLOAD_MB = 90;
