"""Check a trained Gus on messages that are NOT in the training data, twice each, to see variety.

usage: .venv/bin/python sample.py out/gus [n_per_prompt] [--q4]
--q4 runs it with the same 4-bit weights the browser gets (see export.py), to judge the real thing.
"""
import sys, torch
from transformers import AutoTokenizer, AutoModelForCausalLM

args = [a for a in sys.argv[1:] if not a.startswith("--")]
path = args[0]
N = int(args[1]) if len(args) > 1 else 2
tok = AutoTokenizer.from_pretrained(path)
model = AutoModelForCausalLM.from_pretrained(path, dtype=torch.float32).eval()
if "--q4" in sys.argv:
    import numpy as np
    def fake_quant(w, bs=32):
        o, i = w.shape
        wb = w.reshape(o, i // bs, bs)
        lo = np.minimum(wb.min(-1, keepdims=True), 0); hi = np.maximum(wb.max(-1, keepdims=True), 0)
        s = np.maximum((hi - lo) / 15, 1e-12).astype(np.float32)
        z = np.clip(np.round(-lo / s), 0, 15)
        return ((np.clip(np.round(wb / s) + z, 0, 15) - z) * s).reshape(o, i).astype(np.float32)
    with torch.no_grad():
        for mod in list(model.model.layers.modules()) + [model.model.embed_tokens]:
            if isinstance(mod, (torch.nn.Linear, torch.nn.Embedding)):
                mod.weight.copy_(torch.from_numpy(fake_quant(mod.weight.numpy())))
    print("using 4-bit weights")
torch.manual_seed(1)
tests = ["hey there", "what is 6+7", "i like trains", "you're such a loser", "what's the capital of japan",
         "i just got a new bike", "why do birds fly", "no you're wrong and you know it", "can you help me with my essay",
         "i'm going to the movies tonight", "who would win, a bear or a shark", "(silence)", "you are actually kind of nice",
         "my favorite color is green", "do you like anime", "I made pancakes this morning", "what's the best car",
         "my teacher gave me detention", "you're a bot lmao", "explain photosynthesis", "i beat you", "sup gus",
         "what should i name my cat", "i'm 15", "pizza or burgers?", "you smell"]
for t in tests:
    for _ in range(N):
        msgs = [{"role": "system", "content": "You are Gus."}, {"role": "user", "content": t}]
        ids = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt")
        if not torch.is_tensor(ids): ids = ids["input_ids"]
        out = model.generate(ids, max_new_tokens=48, do_sample=True, temperature=0.8, top_p=0.9, top_k=50, repetition_penalty=1.1)
        print(repr(t), "=>", tok.decode(out[0][ids.shape[1]:], skip_special_tokens=True).strip())
