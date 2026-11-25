# gus

A tiny AI that runs entirely in your browser and exists only to ragebait you.

**Live:** https://fordpepper.github.io/ragebait/

- Model: SmolLM2-360M-Instruct, LoRA fine-tuned on handwritten ragebait chats (`train/data_*.txt`),
  exported to ONNX with 4-bit weights and an 8-bit embedding table (~275 MB). It's hosted in this repo
  (`site/models/gus/`, split into <100 MB parts for GitHub) and runs with transformers.js, WebGPU or CPU.
- First visit downloads the model once; after that it's cached and works offline. No server, no API keys.
- Variety: sampling, a repetition penalty, and rejection of replies that start like any of the last 10.
  If you go quiet he pokes you (twice, then he sulks).

## Retraining

```sh
cd train
uv venv -p 3.12 .venv && uv pip install -p .venv/bin/python --index-url https://download.pytorch.org/whl/cpu torch
uv pip install -p .venv/bin/python transformers peft "optimum-onnx[onnxruntime]" onnx onnxruntime onnx-ir
.venv/bin/python train.py HuggingFaceTB/SmolLM2-360M-Instruct out/gus 4   # ~10 min on a 12-core CPU
.venv/bin/python sample.py out/gus                                        # eyeball it
rm -rf ../site/models/gus && .venv/bin/python export.py out/gus ../site/models/gus
python3 split.py ../site/models/gus
```
Add more lines to `train/data_*.txt` (`> user` / `< gus`, blank line between chats) to change his personality.
