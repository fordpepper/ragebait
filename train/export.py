"""Export a trained Gus to ONNX and quantize to 4-bit for the browser.

usage: .venv/bin/python export.py out/gus-360m ../site/models/gus
Writes config/tokenizer files plus onnx/model_q4.onnx (4-bit MatMul + 4-bit embedding Gather).
"""
import sys, shutil, subprocess, pathlib, onnx
from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer, DefaultWeightOnlyQuantConfig

def quantize_embedding(m):
    """8-bit, per-row embedding table using only standard ops (onnxruntime-web has no 4-bit Gather)."""
    import numpy as np
    from onnx import numpy_helper, helper, TensorProto
    inits = {i.name: i for i in m.graph.initializer}
    for node in m.graph.node:
        if node.op_type != "Gather" or node.input[0] not in inits: continue
        w = numpy_helper.to_array(inits[node.input[0]]).astype(np.float32)
        if w.ndim != 2 or w.shape[0] < 10000: continue
        scale = np.maximum(np.abs(w).max(axis=1), 1e-8) / 127.0
        qw = np.clip(np.round(w / scale[:, None]), -127, 127).astype(np.int8)
        name = node.input[0]
        m.graph.initializer.remove(inits[name])
        m.graph.initializer.extend([numpy_helper.from_array(qw, name + "_q8"), numpy_helper.from_array(scale[:, None].astype(np.float32), name + "_scale")])
        out, ids = node.output[0], node.input[1]
        idx = list(m.graph.node).index(node)
        m.graph.node.remove(node)
        new = [helper.make_node("Gather", [name + "_q8", ids], [out + "_q8"], axis=0),
               helper.make_node("Gather", [name + "_scale", ids], [out + "_s"], axis=0),
               helper.make_node("Cast", [out + "_q8"], [out + "_f"], to=TensorProto.FLOAT),
               helper.make_node("Mul", [out + "_f", out + "_s"], [out])]
        for k, n in enumerate(new): m.graph.node.insert(idx + k, n)
        print("embedding", name, w.shape, "-> int8")


src, dst = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
tmp = src.parent / (src.name + "-onnx")
if not (tmp / "model.onnx").exists():
    # Untie the output head from the embeddings so both become constant 4-bit weights
    # (a tied head is exported as a Transpose of the fp32 table and can't be quantized).
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    untied = src.parent / (src.name + "-untied")
    m = AutoModelForCausalLM.from_pretrained(src, torch_dtype=torch.float32)
    m.lm_head.weight = torch.nn.Parameter(m.get_input_embeddings().weight.detach().clone())
    m.config.tie_word_embeddings = False
    m.save_pretrained(untied); AutoTokenizer.from_pretrained(src).save_pretrained(untied)
    subprocess.run([sys.executable, "-m", "optimum.exporters.onnx", "--model", str(untied), "--task", "text-generation-with-past", str(tmp)], check=True)

model = onnx.load(str(tmp / "model.onnx"))
cfg = DefaultWeightOnlyQuantConfig(block_size=32, is_symmetric=True, op_types_to_quantize=("MatMul",))
q = MatMulNBitsQuantizer(model, algo_config=cfg)
q.process()
quantize_embedding(q.model.model)
(dst / "onnx").mkdir(parents=True, exist_ok=True)
q.model.save_model_to_file(str(dst / "onnx" / "model_q4.onnx"), use_external_data_format=False)
for f in ["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"]:
    if (tmp / f).exists(): shutil.copy(tmp / f, dst / f)
# transformers.js reads the chat template from tokenizer_config.json, newer exports keep it in a .jinja file
import json
tc = json.loads((dst / "tokenizer_config.json").read_text())
if "chat_template" not in tc and (tmp / "chat_template.jinja").exists():
    tc["chat_template"] = (tmp / "chat_template.jinja").read_text()
    (dst / "tokenizer_config.json").write_text(json.dumps(tc, indent=2))
print("wrote", dst, (dst / "onnx" / "model_q4.onnx").stat().st_size / 1e6, "MB")
