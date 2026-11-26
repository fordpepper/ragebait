# gus

A tiny AI that runs entirely in your browser and exists only to ragebait you.

**Live:** https://fordpepper.github.io/ragebait/

- **Model:** SmolLM2-135M-Instruct, fully fine-tuned on ~2,600 ragebait chats: ~900 handwritten
  (`train/data_a…f.txt`) and ~1,600 generated from templates (`train/gen_templates.py`). It's then trained a bit
  more at 4-bit precision (quantization-aware) so shrinking it doesn't make it dumber.
  What "ragebait" means here, and the lines Gus doesn't cross, is in [`train/RAGEBAIT.md`](train/RAGEBAIT.md).
- **Size:** the model is a single ~88 MB ONNX file. Every weight is 4-bit, and the embedding table isn't stored
  separately: it's read out of the output layer, which holds the same matrix. First visit is about 90 MB over the
  wire in total. After that everything is cached and Gus works offline.
- **Runs on:** transformers.js + onnxruntime-web in a web worker, multi-threaded CPU (WebAssembly). Add `?gpu` to
  the URL to try WebGPU instead.
- **Variety:** sampling, a repetition penalty, and rejection of replies that start like any of the last 10
  or repeat any of the last 40. If you go quiet he pokes you (twice, then he sulks).
- **Mobile data:** on a cellular or data-saver connection the page asks before downloading.
- **Not a bit:** messages that sound like a real crisis get a straight answer with helpline numbers instead of Gus.

## Retraining

```sh
cd train
uv venv -p 3.12 .venv && uv pip install -p .venv/bin/python --index-url https://download.pytorch.org/whl/cpu torch
uv pip install -p .venv/bin/python transformers peft "optimum-onnx[onnxruntime]" onnx onnxruntime onnx-ir
python3 gen_templates.py                                                   # writes data_t.txt
.venv/bin/python train.py HuggingFaceTB/SmolLM2-135M-Instruct out/gus 3    # ~1 h on a 12-core CPU
.venv/bin/python train.py out/gus out/gus-qat 1 --qat                      # 4-bit-aware pass
.venv/bin/python sample.py out/gus-qat                                     # eyeball it
.venv/bin/python export.py out/gus-qat ../site/models/gus                  # checks itself, fails if > 95 MB
```

Add lines to `train/data_*.txt` (`> user` / `< gus`, blank line between chats) to change his personality.
