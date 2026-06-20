"""End-to-end smoke test: load SenseNova-U1 GGUF + run a 2-step T2I."""
from __future__ import annotations

import gc
import os
import sys
import time

# Windows: transformers' auto_docstring prints emojis and explodes on cp1252.
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(HERE, "models")
GGUF = os.path.join(MODELS_DIR, os.getenv("GGUF_FILE", "SenseNova-U1-8B-MoT-8step-Q4_K_S.gguf"))
sys.path.insert(0, MODELS_DIR)

import torch
import sensenova_u1  # registers neo_chat
from transformers import AutoConfig, AutoModel, AutoTokenizer
from accelerate import init_empty_weights

import gguf as gguf_mod
from gguf import GGUFReader
from diffusers import GGUFQuantizationConfig
from diffusers.quantizers.gguf import GGUFQuantizer
from diffusers.quantizers.gguf.utils import SUPPORTED_GGUF_QUANT_TYPES, GGUFParameter
from diffusers.models.model_loading_utils import load_model_dict_into_meta


def load_gguf_state_dict(path: str) -> dict:
    reader = GGUFReader(path)
    out: dict = {}
    for tensor in reader.tensors:
        name = tensor.name
        qtype = tensor.tensor_type
        is_quant = qtype not in (gguf_mod.GGMLQuantizationType.F32, gguf_mod.GGMLQuantizationType.F16)
        if is_quant and qtype not in SUPPORTED_GGUF_QUANT_TYPES:
            raise ValueError(f"{name}: unsupported quant {qtype}")
        weights = torch.from_numpy(tensor.data.copy())
        out[name] = GGUFParameter(weights, quant_type=qtype) if is_quant else weights
    return out


def main() -> None:
    print(f"torch={torch.__version__} cuda={torch.cuda.is_available()} dev0={torch.cuda.get_device_name(0)}")
    print(f"Loading config + tokenizer from {MODELS_DIR}")
    config = AutoConfig.from_pretrained(MODELS_DIR, trust_remote_code=False)
    tokenizer = AutoTokenizer.from_pretrained(MODELS_DIR, trust_remote_code=False)
    print(f"  config class: {type(config).__name__}")

    print("Instantiating model on meta device...")
    with init_empty_weights():
        model = AutoModel.from_config(config, trust_remote_code=False)
    print(f"  model class : {type(model).__name__}")

    print(f"Reading GGUF: {GGUF} ({os.path.getsize(GGUF) / 1e9:.2f} GB)")
    t0 = time.time()
    sd = load_gguf_state_dict(GGUF)
    print(f"  {len(sd)} tensors loaded from gguf in {time.time() - t0:.1f}s")

    print("Loading state dict into model on CPU...")
    t0 = time.time()
    quantizer = GGUFQuantizer(quantization_config=GGUFQuantizationConfig(compute_dtype=torch.bfloat16))
    quantizer.pre_quantized = True
    quantizer._process_model_before_weight_loading(model, device_map={"": torch.device("cpu")}, state_dict=sd)
    load_model_dict_into_meta(model, sd, hf_quantizer=quantizer, device_map={"": torch.device("cpu")}, dtype=torch.bfloat16)
    quantizer._process_model_after_weight_loading(model)
    del sd
    gc.collect()
    print(f"  Done in {time.time() - t0:.1f}s")

    print("Running tiny T2I (2 steps, 256x256)...")
    t0 = time.time()
    tensor = model.t2i_generate(
        tokenizer,
        "a small green apple on a white background",
        image_size=(256, 256),
        cfg_scale=4.0,
        cfg_norm="none",
        timestep_shift=3.0,
        cfg_interval=(0.0, 1.0),
        num_steps=2,
        batch_size=1,
        seed=0,
        think_mode=False,
    )
    print(f"  shape={tuple(tensor.shape)} in {time.time() - t0:.1f}s")

    # Save
    import numpy as np
    from PIL import Image
    NORM_MEAN = (0.5, 0.5, 0.5)
    NORM_STD = (0.5, 0.5, 0.5)
    mean = torch.tensor(NORM_MEAN, dtype=tensor.dtype, device=tensor.device).view(1, 3, 1, 1)
    std = torch.tensor(NORM_STD, dtype=tensor.dtype, device=tensor.device).view(1, 3, 1, 1)
    arr = (tensor * std + mean).clamp(0, 1).float().permute(0, 2, 3, 1).cpu().numpy()
    arr = (arr * 255.0).round().astype(np.uint8)
    out_path = os.path.join(HERE, "smoke_out.png")
    Image.fromarray(arr[0]).save(out_path)
    print(f"  saved {out_path}")


if __name__ == "__main__":
    main()
