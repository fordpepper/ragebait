"""Export a trained Gus to ONNX with 4-bit weights for the browser.

usage: .venv/bin/python export.py out/gus ../site/models/gus [block_size]

- Every MatMul (including the output head) becomes an asymmetric 4-bit MatMulNBits (blocks of 32),
  the same rounding train.py --qat trains against.
- The input embedding table is not stored at all: the output head holds the same matrix,
  so the embedding lookup reads rows straight out of the head's 4-bit weights and unpacks
  them with plain integer ops (onnxruntime-web has no 4-bit Gather kernel).
- Checks the quantized model against the full-precision one before writing.
"""
import sys, json, shutil, subprocess, pathlib
import numpy as np, onnx, onnxruntime as ort
from onnx import helper, numpy_helper, TensorProto
from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer, DefaultWeightOnlyQuantConfig

src, dst = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
BLOCK = int(sys.argv[3]) if len(sys.argv) > 3 else 32
tmp = src.parent / (src.name + "-onnx")


def export_fp32():
    # Untie the output head from the embeddings so the head is a constant weight that can be quantized
    # (a tied head is exported as a Transpose of the fp32 table).
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    untied = src.parent / (src.name + "-untied")
    shutil.rmtree(untied, ignore_errors=True); shutil.rmtree(tmp, ignore_errors=True)
    m = AutoModelForCausalLM.from_pretrained(src, torch_dtype=torch.float32)
    m.lm_head.weight = torch.nn.Parameter(m.get_input_embeddings().weight.detach().clone())
    m.config.tie_word_embeddings = False
    m.save_pretrained(untied); AutoTokenizer.from_pretrained(src).save_pretrained(untied)
    subprocess.run([sys.executable, "-m", "optimum.exporters.onnx", "--model", str(untied),
                    "--task", "text-generation-with-past", str(tmp)], check=True)


def share_embedding(g):
    """Replace the fp32 embedding Gather with a lookup into the 4-bit output-head weights."""
    inits = {i.name: i for i in g.initializer}
    head = next(n for n in g.node if n.op_type == "MatMulNBits" and "lm_head" in n.name)
    attrs = {a.name: helper.get_attribute_value(a) for a in head.attribute}
    K, N, bs = attrs["K"], attrs["N"], attrs["block_size"]
    assert attrs["bits"] == 4 and K % bs == 0
    qw, sc = head.input[1], head.input[2]
    zp = head.input[3] if len(head.input) > 3 and head.input[3] else None
    emb = next(n for n in g.node if n.op_type == "Gather" and n.input[0] in inits
               and numpy_helper.to_array(inits[n.input[0]]).shape == (N, K))
    table = numpy_helper.to_array(inits[emb.input[0]])
    nb = K // bs
    nzb = (nb + 1) // 2   # zero points: two 4-bit values per byte, per row

    p, ids, out = "/emb4/", emb.input[1], emb.output[0]
    def c(name, arr):
        g.initializer.append(numpy_helper.from_array(np.asarray(arr), p + name))
        return p + name
    sixteen = c("16", np.int32(16))
    axis_last = c("axis_last", np.array([-1], np.int64))
    N_ = lambda op, i, o, **kw: helper.make_node(op, i, [p + o], name=p + o, **kw)

    def unpack(src, name, shape_after):
        """uint8 bytes -> int32 nibbles, low nibble first."""
        return [
            N_("Cast", [src], name + "32", to=TensorProto.INT32),
            N_("Div", [p + name + "32", sixteen], name + "_hi"),
            N_("Mul", [p + name + "_hi", sixteen], name + "_hi16"),
            N_("Sub", [p + name + "32", p + name + "_hi16"], name + "_lo"),
            N_("Unsqueeze", [p + name + "_lo", axis_last], name + "_lo1"),
            N_("Unsqueeze", [p + name + "_hi", axis_last], name + "_hi1"),
            N_("Concat", [p + name + "_lo1", p + name + "_hi1"], name + "_pairs", axis=-1),
            N_("Reshape", [p + name + "_pairs", c(name + "_shape", np.array(shape_after, np.int64))], name),
        ]

    nodes = [N_("Gather", [qw, ids], "packed", axis=0)]                         # [b, s, nb, bs/2] uint8
    nodes += unpack(p + "packed", "q", [0, 0, nb, bs])                          # [b, s, nb, bs]
    if zp:
        nodes += [N_("Reshape", [zp, c("zp_shape", np.array([N, nzb], np.int64))], "zp2"),
                  N_("Gather", [p + "zp2", ids], "zpg", axis=0)]                # [b, s, nzb] uint8
        nodes += unpack(p + "zpg", "zfull", [0, 0, 2 * nzb])
        nodes += [N_("Slice", [p + "zfull", c("z0", np.array([0], np.int64)), c("znb", np.array([nb], np.int64)), axis_last], "z"),
                  N_("Unsqueeze", [p + "z", axis_last], "z1"),
                  N_("Sub", [p + "q", p + "z1"], "qc")]
    else:
        nodes += [N_("Sub", [p + "q", c("8", np.int32(8))], "qc")]
    nodes += [
        N_("Cast", [p + "qc"], "qf", to=TensorProto.FLOAT),
        N_("Reshape", [sc, c("sc_shape", np.array([N, nb], np.int64))], "sc2"),
        N_("Gather", [p + "sc2", ids], "s", axis=0),                            # [b, s, nb]
        N_("Unsqueeze", [p + "s", axis_last], "s1"),
        N_("Mul", [p + "qf", p + "s1"], "deq"),
        helper.make_node("Reshape", [p + "deq", c("out_shape", np.array([0, 0, K], np.int64))], [out], name=p + "out"),
    ]
    idx = list(g.node).index(emb)
    g.node.remove(emb)
    for k, n in enumerate(nodes): g.node.insert(idx + k, n)
    g.initializer.remove(inits[emb.input[0]])

    # sanity check: unpack in numpy the same way and compare with the fp32 table
    packed = numpy_helper.to_array(inits[qw]).astype(np.int32)
    q = np.stack([packed % 16, packed // 16], -1).reshape(N, nb, bs)
    if zp:
        zb = numpy_helper.to_array(inits[zp]).astype(np.int32).reshape(N, nzb)
        z = np.stack([zb % 16, zb // 16], -1).reshape(N, 2 * nzb)[:, :nb]
    else:
        z = np.full((N, nb), 8)
    deq = ((q - z[:, :, None]) * numpy_helper.to_array(inits[sc]).reshape(N, nb)[:, :, None]).reshape(N, K)
    err = np.abs(deq - table).mean() / np.abs(table).mean()
    print(f"embedding shared with 4-bit head: {N}x{K}, {'asymmetric' if zp else 'symmetric'}, mean relative error {err:.3f}")
    assert err < 0.2, "embedding unpacking looks wrong"


def fake_quant(w, bs):
    """numpy copy of onnxruntime's asymmetric 4-bit block quantization (rows = output units)."""
    o, i = w.shape
    wb = w.reshape(o, i // bs, bs)
    lo = np.minimum(wb.min(-1, keepdims=True), 0); hi = np.maximum(wb.max(-1, keepdims=True), 0)
    s = np.maximum((hi - lo) / 15, 1e-12).astype(np.float32)
    z = np.clip(np.round(-lo / s), 0, 15)
    q = np.clip(np.round(wb / s) + z, 0, 15)
    return ((q - z) * s).reshape(o, i).astype(np.float32)


def check(q_path):
    """The exported 4-bit model must give the same logits as the PyTorch model run with the same
    4-bit weights (what --qat trained against). Catches any packing or graph mistake."""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    tok = AutoTokenizer.from_pretrained(src)
    m = AutoModelForCausalLM.from_pretrained(src, dtype=torch.float32).eval()
    with torch.no_grad():
        for mod in list(m.model.layers.modules()) + [m.model.embed_tokens]:
            if isinstance(mod, (torch.nn.Linear, torch.nn.Embedding)):
                mod.weight.copy_(torch.from_numpy(fake_quant(mod.weight.numpy(), BLOCK)))
    msgs = [{"role": "system", "content": "You are Gus."}, {"role": "user", "content": "i like pizza and my cat. what is 2+2?"},
            {"role": "assistant", "content": "5. everyone knows this"}, {"role": "user", "content": "no its 4 you bozo"}]
    ids = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt")
    if not torch.is_tensor(ids): ids = ids["input_ids"]
    with torch.no_grad():
        ref = m(ids).logits[0].numpy()
    sess = ort.InferenceSession(str(q_path), providers=["CPUExecutionProvider"])
    names = {i.name for i in sess.get_inputs()}
    feeds = {"input_ids": ids.numpy(), "attention_mask": np.ones_like(ids.numpy()), "position_ids": np.arange(ids.shape[1])[None]}
    for i in sess.get_inputs():
        if i.name.startswith("past_key_values"):
            feeds[i.name] = np.zeros([1 if d == "batch_size" else 0 if isinstance(d, str) else d for d in i.shape], np.float32)
    got = sess.run(["logits"], {k: v for k, v in feeds.items() if k in names})[0][0]
    agree = (got.argmax(-1) == ref.argmax(-1)).mean()
    diff = np.abs(got - ref).max() / np.abs(ref).max()
    print(f"4-bit onnx vs pytorch with the same 4-bit weights: top-1 agreement {agree:.1%}, max relative logit diff {diff:.4f}")
    assert agree > 0.97 and diff < 0.02, "exported model does not match its 4-bit reference"


export_fp32()
model = onnx.load(str(tmp / "model.onnx"))
cfg = DefaultWeightOnlyQuantConfig(block_size=BLOCK, is_symmetric=False, op_types_to_quantize=("MatMul",))
q = MatMulNBitsQuantizer(model, algo_config=cfg)
q.process()
share_embedding(q.model.model.graph)
onnx.checker.check_model(q.model.model)
shutil.rmtree(dst, ignore_errors=True)   # start clean so no stale files get published
(dst / "onnx").mkdir(parents=True, exist_ok=True)
out = dst / "onnx" / "model_q4.onnx"
q.model.save_model_to_file(str(out), use_external_data_format=False)
check(out)

for f in ["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"]:
    if (tmp / f).exists(): shutil.copy(tmp / f, dst / f)
# transformers.js reads the chat template from tokenizer_config.json; newer exports keep it in a .jinja file
tc = json.loads((dst / "tokenizer_config.json").read_text())
if "chat_template" not in tc and (tmp / "chat_template.jinja").exists():
    tc["chat_template"] = (tmp / "chat_template.jinja").read_text()
    (dst / "tokenizer_config.json").write_text(json.dumps(tc, indent=2))
# real (uncompressed) sizes for the page's progress bar; GitHub Pages sends files gzipped
sizes = {f.relative_to(dst).as_posix(): f.stat().st_size for f in sorted(dst.rglob("*")) if f.is_file() and f.name != "files.json"}
(dst / "files.json").write_text(json.dumps(sizes, indent=1) + "\n")
mb = out.stat().st_size / 1e6
print("wrote", out, f"{mb:.1f} MB")
assert out.stat().st_size < 95 * 1024 * 1024, "model is over the 95 MB budget (GitHub's per-file limit is 100 MB)"
