# gus

A small AI that lives in your browser, sits in your DMs and exists only to ragebait you.

**Live:** https://fordpepper.github.io/ragebait/

- **Feels like a person.** The model writes the words; `site/app.js` handles the human parts. Gus waits until
  you've finished typing and takes a moment to read. He types at human speed, sometimes pausing mid-message, and
  sometimes sends a reply as two or three messages. Now and then he makes a typo and fixes it with `*word`.
  He reacts to your messages with emojis. He notices when you start typing and stop, or write something long and
  delete it. If you go quiet he pokes you twice, then goes idle and sulks.
- **Looks like a chat app.** A dark DM layout with a server rail, a DM list, message groups with timestamps,
  reactions, a typing indicator, an emoji picker and a profile panel. On phones the sidebars slide away.
- **Model:** SmolLM2-360M-Instruct, fully fine-tuned on ragebait chats: handwritten (`train/data_a…h.txt`) and
  template-generated (`train/gen_templates.py`). Then a quantization-aware pass trains it at 4-bit so shrinking
  doesn't make it dumber. What "ragebait" means here, and the lines Gus doesn't cross, is in
  [`train/RAGEBAIT.md`](train/RAGEBAIT.md).
- **Size:** every weight is 4-bit, and the embedding table is read from the output layer instead of being stored
  twice. The file is stored in <100 MB parts because of GitHub's file limit, and the page streams them back
  together. First visit downloads it once; after that it's cached and works offline. On mobile data the page
  asks first.
- **Runs on:** transformers.js + onnxruntime-web in a web worker, multi-threaded CPU. Add `?gpu` to the URL to try
  WebGPU.
- **Limits:** a filter regenerates any reply with slurs or attacks on who someone is. Messages that sound like a
  real crisis get helpline numbers instead of Gus.

## Retraining

```sh
cd train
uv venv -p 3.12 .venv && uv pip install -p .venv/bin/python --index-url https://download.pytorch.org/whl/cpu torch
uv pip install -p .venv/bin/python transformers peft "optimum-onnx[onnxruntime]" onnx onnxruntime onnx-ir
python3 gen_templates.py                                                    # writes data_t.txt
.venv/bin/python train.py HuggingFaceTB/SmolLM2-360M-Instruct out/gus 2     # a few hours on a 12-core CPU
.venv/bin/python train.py out/gus out/gus-qat 1 --qat                       # 4-bit-aware pass
.venv/bin/python sample.py out/gus-qat 2 --q4                               # eyeball it at 4-bit
.venv/bin/python export.py out/gus-qat ../site/models/gus-vN                # checks itself against PyTorch
```

Then set `MODEL.id` in `site/config.js` to the new folder name. Browsers cache the model by URL, so a new
model needs a new folder. Add lines to `train/data_*.txt` to change his personality: `> user` / `< gus`, a
blank line between chats, and extra lines without a prefix for a burst of messages.
