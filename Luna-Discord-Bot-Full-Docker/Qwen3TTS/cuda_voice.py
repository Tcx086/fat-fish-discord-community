"""Offline CustomVoice inference shared by the audition and loopback service."""
import io
import json
from pathlib import Path
import threading
import time

import numpy as np
import soundfile as sf

EXPRESSIONS = json.loads(Path(__file__).with_name("expressions.json").read_text(encoding="utf-8"))
PARAMETERS = dict(do_sample=True, top_k=50, top_p=1.0, temperature=0.9,
                  subtalker_dosample=True, subtalker_top_k=50, subtalker_top_p=1.0,
                  subtalker_temperature=0.9, repetition_penalty=1.05, max_new_tokens=512,
                  non_streaming_mode=True)


class SynthesisCancelled(Exception):
    pass


def instruction(expression="neutral", instruct=None):
    label = expression if expression in EXPRESSIONS else "neutral"
    return label, EXPRESSIONS[label] if instruct is None else instruct


def wav_bytes(samples, sample_rate):
    audio = np.asarray(samples, dtype=np.float32)
    if audio.ndim != 1 or not len(audio) or not np.isfinite(audio).all():
        raise ValueError("Expected finite, nonempty mono audio")
    output = io.BytesIO()
    sf.write(output, np.clip(audio, -1, 1), sample_rate, format="WAV", subtype="PCM_16")
    return output.getvalue()


class VoiceEngine:
    def __init__(self, model_path):
        # Only an explicitly downloaded local model is allowed at runtime.
        path = Path(model_path).resolve()
        if not (path / "model.safetensors").is_file():
            raise FileNotFoundError("Local CustomVoice checkpoint is missing")
        import torch
        from qwen_tts import Qwen3TTSModel
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA GPU required by this evaluation adapter")
        self.torch = torch
        torch.set_num_threads(4)
        self.started = time.perf_counter()
        self.model = Qwen3TTSModel.from_pretrained(str(path), device_map="cuda:0",
                        dtype=torch.bfloat16, attn_implementation="sdpa", local_files_only=True)
        torch.cuda.synchronize()
        self.load_seconds = time.perf_counter() - self.started
        self.hardware = {"gpu": torch.cuda.get_device_name(0), "torch": torch.__version__,
                         "cuda": torch.version.cuda, "attention": "sdpa", "dtype": "bfloat16"}
        self.lock = threading.Lock()

    def synthesize(self, text, speaker="Vivian", language="Auto", expression="neutral",
                   instruct=None, seed=42, cancel=None):
        torch = self.torch
        cancel = cancel or threading.Event()
        with self.lock:
            started = time.perf_counter()
            label, direction = instruction(expression, instruct)
            def check_cancel(*_):
                if cancel.is_set():
                    raise SynthesisCancelled()
                if time.perf_counter() - started > 90:
                    raise TimeoutError("Synthesis exceeded 90 seconds")
            check_cancel()
            # qwen-tts 0.1.1 drops stopping_criteria; use a removable forward hook.
            # shortcut: decoder kernels cannot be interrupted; use native SDK cancellation when available.
            hook = self.model.model.talker.register_forward_pre_hook(check_cancel)
            torch.manual_seed(seed)
            torch.cuda.reset_peak_memory_stats()
            try:
                with torch.inference_mode():
                    wavs, rate = self.model.generate_custom_voice(text=text, speaker=speaker,
                        language=language, instruct=direction, **PARAMETERS)
                torch.cuda.synchronize()
                check_cancel()
                data = wav_bytes(wavs[0], rate)
                elapsed = time.perf_counter() - started
                return data, {"expression": label, "instruction": direction, "seed": seed,
                    "sample_rate": rate, "duration_seconds": len(wavs[0]) / rate,
                    "synthesis_seconds": elapsed, "first_audio_seconds": elapsed,
                    "rtf": elapsed / (len(wavs[0]) / rate),
                    "gpu_peak_allocated_bytes": torch.cuda.max_memory_allocated(),
                    "gpu_peak_reserved_bytes": torch.cuda.max_memory_reserved()}
            finally:
                hook.remove()

    def close(self):
        with self.lock:
            self.model = None
            import gc
            gc.collect()
            self.torch.cuda.empty_cache()
