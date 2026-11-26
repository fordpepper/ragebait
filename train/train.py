"""Fine-tune a tiny chat model into Gus on CPU.

usage: .venv/bin/python train.py [base_model] [out_dir] [epochs] [--lora] [--qat]

Full fine-tune by default (fine for 135M on CPU); --lora for bigger bases.
--qat: quantization-aware pass. The weights are trained through the exact 4-bit rounding that
export.py applies (asymmetric, blocks of 32, same formula as onnxruntime's MatMulNBits), so the
model learns to work at 4 bits instead of being damaged by it. Run it on an already trained model.
Files data_d/e/f (the meaner, research-based sets) count twice. Every handwritten conversation also
gets a copy with the user's typing changed (caps, punctuation, typos) so Gus copes with messy input.
data_t.txt comes from gen_templates.py.
"""
import random, sys, pathlib, re, torch
from transformers import AutoTokenizer, AutoModelForCausalLM

args = [a for a in sys.argv[1:] if not a.startswith("--")]
BASE = args[0] if len(args) > 0 else "HuggingFaceTB/SmolLM2-135M-Instruct"
OUT = args[1] if len(args) > 1 else "out/gus"
EPOCHS = int(args[2]) if len(args) > 2 else 3
LORA = "--lora" in sys.argv
QAT = "--qat" in sys.argv
QBLOCK = 32
SYSTEM = "You are Gus."
WEIGHT = {"data_d.txt": 2, "data_e.txt": 2, "data_f.txt": 2}
here = pathlib.Path(__file__).parent
torch.manual_seed(0); random.seed(0)
torch.set_num_threads(12)


def load_convos():
    convos = []
    for f in sorted(here.glob("data_*.txt")):
        cur, found = [], []
        for line in f.read_text().splitlines() + [""]:
            if line.startswith("#"):
                continue
            if not line.strip():
                if cur: found.append(cur); cur = []
            elif line.startswith("> "):
                cur.append({"role": "user", "content": line[2:].strip()})
            elif line.startswith("< "):
                cur.append({"role": "assistant", "content": line[2:].strip()})
        for c in found:
            assert c[0]["role"] == "user" and all(a["role"] != b["role"] for a, b in zip(c, c[1:])), (f.name, c)
        convos += [(c, f.name != "data_t.txt") for c in found] * WEIGHT.get(f.name, 1)
    return convos


def messy(text):
    """The same message typed differently."""
    if text.startswith("("):
        return text
    t = text
    r = random.random()
    if r < 0.25: t = t[:1].upper() + t[1:]
    elif r < 0.35: t = t.upper()
    elif r < 0.5: t = t.replace("'", "")
    elif r < 0.6: t = re.sub(r"\byou\b", "u", t); t = re.sub(r"\byour\b", "ur", t)
    elif r < 0.7 and len(t) > 4:
        i = random.randrange(1, len(t) - 1); t = t[:i] + t[i + 1] + t[i] + t[i + 2:]   # swap two letters
    if random.random() < 0.3: t += random.choice(["?", "!", ".", "??", "!!", " lol", " bro"])
    if random.random() < 0.1: t = "gus " + t
    return t


tok = AutoTokenizer.from_pretrained(BASE)
model = AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=torch.float32)
if LORA:
    from peft import LoraConfig, get_peft_model
    model = get_peft_model(model, LoraConfig(r=32, lora_alpha=64, lora_dropout=0.05, task_type="CAUSAL_LM",
                                             target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]))
if QAT:
    import types
    import torch.nn.functional as F

    def fake_quant(w):
        """Asymmetric 4-bit, blocks of QBLOCK along the input dim; identical to onnxruntime's quantize_matmul_4bits.
        Straight-through estimator: forward sees the 4-bit weights, gradients flow to the float ones."""
        o, i = w.shape
        wb = w.reshape(o, i // QBLOCK, QBLOCK)
        lo = wb.amin(-1, keepdim=True).clamp(max=0)
        hi = wb.amax(-1, keepdim=True).clamp(min=0)
        s = ((hi - lo) / 15).clamp(min=1e-12)
        z = torch.clamp(torch.round(-lo / s), 0, 15)
        q = torch.clamp(torch.round(wb / s) + z, 0, 15)
        return w + (((q - z) * s).reshape(o, i) - w).detach()

    for mod in model.model.layers.modules():
        if isinstance(mod, torch.nn.Linear):
            mod.forward = types.MethodType(lambda self, x: F.linear(x, fake_quant(self.weight), self.bias), mod)
    # the embedding and the output head share one matrix; at export the head is 4-bit and the embedding reads from it
    emb = model.model.embed_tokens
    assert model.lm_head.weight is emb.weight, "expected tied embeddings"
    emb.forward = types.MethodType(lambda self, ids: F.embedding(ids, fake_quant(self.weight)), emb)
    model.lm_head.forward = types.MethodType(lambda self, x: F.linear(x, fake_quant(self.weight)), model.lm_head)
    print("quantization-aware training on")

HDR = len(tok("<|im_start|>assistant\n", add_special_tokens=False)["input_ids"])


def encode(convo):
    """Tokens for the whole chat; loss only on Gus's turns (reply + end token)."""
    msgs = [{"role": "system", "content": SYSTEM}]
    ids, labels = [], []
    for m in convo:
        before = tok.apply_chat_template(msgs, tokenize=False)
        msgs.append(m)
        after = tok.apply_chat_template(msgs, tokenize=False)
        assert after.startswith(before)
        if not ids:
            head = tok(before, add_special_tokens=False)["input_ids"]
            ids += head; labels += [-100] * len(head)
        piece = tok(after[len(before):], add_special_tokens=False)["input_ids"]
        ids += piece
        labels += ([-100] * HDR + piece[HDR:]) if m["role"] == "assistant" else [-100] * len(piece)
    return torch.tensor(ids), torch.tensor(labels)


loaded = load_convos()
convos = [c for c, _ in loaded]
# generated chats (data_t) are varied already; only the handwritten ones get a messy-typing copy
convos += [[dict(m, content=messy(m["content"])) if m["role"] == "user" else m for m in c] for c, aug in loaded if aug]
print(len(convos), "conversations,", sum(1 for c in convos for m in c if m["role"] == "assistant"), "replies (incl. repeats)")
data = [encode(c) for c in convos]
params = [p for p in model.parameters() if p.requires_grad]
LR = 2e-4 if LORA else 2e-5 if QAT else 6e-5
opt = torch.optim.AdamW(params, lr=LR, weight_decay=0.01)
BATCH = 16
steps = EPOCHS * ((len(data) + BATCH - 1) // BATCH)
sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=LR, total_steps=steps, pct_start=0.06)
model.train()
step = 0
pad = tok.pad_token_id if tok.pad_token_id is not None else 0
for ep in range(EPOCHS):
    random.shuffle(data)
    tot = 0.0
    for i in range(0, len(data), BATCH):
        batch = data[i:i + BATCH]
        L = max(len(x) for x, _ in batch)
        ids = torch.stack([torch.cat([x, torch.full((L - len(x),), pad)]) for x, _ in batch])
        lab = torch.stack([torch.cat([y, torch.full((L - len(y),), -100)]) for _, y in batch])
        att = torch.stack([torch.cat([torch.ones(len(x)), torch.zeros(L - len(x))]) for x, _ in batch]).long()
        loss = model(input_ids=ids, attention_mask=att, labels=lab).loss
        loss.backward(); torch.nn.utils.clip_grad_norm_(params, 1.0)
        opt.step(); sched.step(); opt.zero_grad(); step += 1; tot += loss.item()
        if step % 20 == 0: print(f"epoch {ep} step {step}/{steps} loss {loss.item():.3f}", flush=True)
    print(f"epoch {ep} mean loss {tot / ((len(data) + BATCH - 1) // BATCH):.3f}", flush=True)

if LORA:
    model = model.merge_and_unload()
model.save_pretrained(OUT); tok.save_pretrained(OUT)
print("saved", OUT)
