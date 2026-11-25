// The model lives on this site under ./models/<id>/ (fine-tuned SmolLM2 "Gus", 4-bit ONNX).
// Files over GitHub's 100 MB limit are split into parts listed in parts.json and glued back in the browser.
export const MODEL = {
  id: 'gus',
  dtype: 'q4',
};
