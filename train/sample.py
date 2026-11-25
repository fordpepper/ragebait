"""Quick check of a trained Gus: replies to unseen messages, twice each, to see variety."""
import sys, torch
from transformers import AutoTokenizer, AutoModelForCausalLM

path = sys.argv[1]
tok = AutoTokenizer.from_pretrained(path)
model = AutoModelForCausalLM.from_pretrained(path, torch_dtype=torch.float32).eval()
tests = ["hey there", "what is 3+3", "i like trains", "you're such a loser", "what's the capital of japan",
         "i just got a new bike", "why do birds fly", "no you're wrong and you know it", "can you help me with my essay",
         "i'm going to the movies tonight", "who would win, a bear or a shark", "(silence)", "(silence)", "you are actually kind of nice",
         "my favorite color is green", "do you like anime"]
for t in tests:
    for _ in range(2):
        msgs = [{"role": "system", "content": "You are Gus."}, {"role": "user", "content": t}]
        ids = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt")
        out = model.generate(ids, max_new_tokens=48, do_sample=True, temperature=0.9, top_p=0.92, repetition_penalty=1.1)
        print(repr(t), "=>", tok.decode(out[0][ids.shape[1]:], skip_special_tokens=True).strip())
