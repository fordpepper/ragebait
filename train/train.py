"""Fine-tune a tiny chat model into Gus. CPU is fine: ~400 short examples, LoRA, a few epochs.

usage: .venv/bin/python train.py [base_model] [out_dir] [epochs]
"""
import random, sys, pathlib, torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from peft import LoraConfig, get_peft_model

BASE = sys.argv[1] if len(sys.argv) > 1 else "HuggingFaceTB/SmolLM2-360M-Instruct"
OUT = sys.argv[2] if len(sys.argv) > 2 else "out/gus-360m"
EPOCHS = int(sys.argv[3]) if len(sys.argv) > 3 else 3
SYSTEM = "You are Gus."
here = pathlib.Path(__file__).parent
torch.manual_seed(0); random.seed(0)
torch.set_num_threads(12)


def load_convos():
    convos = []
    for f in sorted(here.glob("data_*.txt")):
        cur = []
        for line in f.read_text().splitlines() + [""]:
            if line.startswith("#"):
                continue
            if not line.strip():
                if cur: convos.append(cur); cur = []
            elif line.startswith("> "):
                cur.append({"role": "user", "content": line[2:].strip()})
            elif line.startswith("< "):
                cur.append({"role": "assistant", "content": line[2:].strip()})
    return convos


tok = AutoTokenizer.from_pretrained(BASE)
model = AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=torch.float32)
model = get_peft_model(model, LoraConfig(r=32, lora_alpha=64, lora_dropout=0.05, task_type="CAUSAL_LM",
                                         target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]))
model.print_trainable_parameters()


def encode(convo):
    """Tokens for the whole chat; loss only on Gus's turns."""
    msgs = [{"role": "system", "content": SYSTEM}]
    ids, labels = [], []
    for m in convo:
        before = tok.apply_chat_template(msgs, tokenize=False)
        msgs.append(m)
        after = tok.apply_chat_template(msgs, tokenize=False)
        piece = tok(after[len(before):], add_special_tokens=False)["input_ids"]
        if not ids:
            head = tok(before, add_special_tokens=False)["input_ids"]
            ids += head; labels += [-100] * len(head)
        ids += piece
        if m["role"] == "assistant":
            # don't learn the "<|im_start|>assistant\n" header, only the reply and the end token
            hdr = len(tok("<|im_start|>assistant\n", add_special_tokens=False)["input_ids"])
            labels += [-100] * hdr + piece[hdr:]
        else:
            labels += [-100] * len(piece)
    return torch.tensor(ids), torch.tensor(labels)


convos = load_convos()
print(len(convos), "conversations,", sum(1 for c in convos for m in c if m["role"] == "assistant"), "replies")
data = [encode(c) for c in convos]
opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=2e-4, weight_decay=0.0)
BATCH = 8
steps = EPOCHS * ((len(data) + BATCH - 1) // BATCH)
sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=2e-4, total_steps=steps, pct_start=0.1)
model.train()
step = 0
for ep in range(EPOCHS):
    random.shuffle(data)
    for i in range(0, len(data), BATCH):
        batch = data[i:i + BATCH]
        L = max(len(x) for x, _ in batch)
        pad = tok.pad_token_id if tok.pad_token_id is not None else 0
        ids = torch.stack([torch.cat([x, torch.full((L - len(x),), pad)]) for x, _ in batch])
        lab = torch.stack([torch.cat([y, torch.full((L - len(y),), -100)]) for _, y in batch])
        att = torch.stack([torch.cat([torch.ones(len(x)), torch.zeros(L - len(x))]) for x, _ in batch]).long()
        loss = model(input_ids=ids, attention_mask=att, labels=lab).loss
        loss.backward(); opt.step(); sched.step(); opt.zero_grad(); step += 1
        if step % 10 == 0: print(f"epoch {ep} step {step}/{steps} loss {loss.item():.3f}", flush=True)

model = model.merge_and_unload()
model.save_pretrained(OUT); tok.save_pretrained(OUT)
print("saved", OUT)
