"""Keep CosyVoice warm; discard cancelled results before reusing its pipe."""
import hashlib
import io
import json
import multiprocessing as mp
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "Qwen3TTS"))
from cuda_voice import SynthesisCancelled


def denoise_audio(audio, sample_rate):
    """Light spectral reduction, retaining speech timing and a soft noise floor."""
    import numpy as np
    audio = np.asarray(audio, dtype='<f4')
    if sample_rate != 24000 or audio.ndim != 1 or not len(audio) or not np.isfinite(audio).all():
        raise ValueError('Expected finite mono 24 kHz audio')
    # afftdn delays 25 ms at 24 kHz; pad then trim so the last syllable is not lost.
    filters = 'apad=pad_len=600,afftdn=nr=12:nf=-35:tn=0:gs=8,atrim=start_sample=600'
    try:
        result = subprocess.run([
            'ffmpeg', '-v', 'error', '-nostdin', '-f', 'f32le', '-ar', '24000', '-ac', '1',
            '-i', 'pipe:0', '-af', filters, '-f', 'f32le', 'pipe:1',
        ], input=audio.tobytes(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=True)
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError('Voice noise reduction failed') from error
    if len(result.stdout) != audio.nbytes:
        raise ValueError('Noise reduction changed audio length')
    cleaned = np.frombuffer(result.stdout, dtype='<f4')
    if not np.isfinite(cleaned).all():
        raise ValueError('Invalid denoised audio')
    return cleaned


def worker(connection, package, source, cache_reference=True):
    try:
        os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", OMP_NUM_THREADS="4")
        sys.path[:0] = [source, str(Path(source) / "third_party/Matcha-TTS")]
        os.chdir(source)
        import numpy as np
        import soundfile as sf
        import torch
        import onnxruntime as ort
        import modelscope
        cached_snapshot = modelscope.snapshot_download
        def offline_snapshot(*args, **kwargs):
            kwargs["local_files_only"] = True
            return cached_snapshot(*args, **kwargs)
        # The optional wetext frontend otherwise contacts ModelScope on every load.
        modelscope.snapshot_download = offline_snapshot
        from cosyvoice.cli.cosyvoice import AutoModel
        from cosyvoice.utils.common import set_all_random_seed
        import logging
        # Upstream INFO/WARNING messages include utterance text.
        logging.getLogger().setLevel(logging.ERROR)

        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is required")
        torch.set_num_threads(4)
        package = Path(package)
        manifest = json.loads((package / "manifest.json").read_text())
        selected = manifest["styles"]["cute"]
        denoise = selected.get('denoise', False)
        if not isinstance(denoise, bool):
            raise ValueError('Invalid voice denoise setting')
        for filename, expected in [(selected["llm_checkpoint"], selected["llm_sha256"]),
                                   (selected["reference_audio"], selected["reference_sha256"])]:
            with (package / filename).open("rb") as f:
                if hashlib.file_digest(f, "sha256").hexdigest() != expected:
                    raise ValueError("Selected voice checksum mismatch")
        # Match the publisher's CPU ONNX frontend; main networks remain on CUDA.
        original_session = ort.InferenceSession
        def cpu_session(*args, **kwargs):
            kwargs["providers"] = ["CPUExecutionProvider"]
            return original_session(*args, **kwargs)
        ort.InferenceSession = cpu_session
        try:
            voice = AutoModel(model_dir=str(package / manifest["base_model_dir"]),
                              fp16=False, load_trt=False, load_vllm=False)
        finally:
            ort.InferenceSession = original_session
        state = torch.load(package / selected["llm_checkpoint"], map_location="cpu", weights_only=True)
        voice.model.llm.load_state_dict(state, strict=True)
        del state
        voice.model.llm.eval()
        for name in ("llm", "flow", "hift"):
            if next(getattr(voice.model, name).parameters()).device.type != "cuda":
                raise RuntimeError("Model is not on CUDA")
        vocoder_audio_limit = voice.model.hift.audio_limit
        prompt = manifest["inference"]["prompt_prefix"] + selected["reference_text"]
        reference = str(package / selected["reference_audio"])
        if cache_reference:
            with torch.inference_mode():
                normalized = voice.frontend.text_normalize(prompt, split=False, text_frontend=True)
                voice.add_zero_shot_spk(normalized, reference, "feiyu-cute")
        connection.send(("ready", None))
        while True:
            request = connection.recv()
            if request is None:
                break
            text, stream = request
            if denoise and stream:
                raise ValueError('Denoised voice requires buffered output')
            started = time.perf_counter()
            set_all_random_seed(42)
            chunks = []
            # CosyVoice mutates this across streaming calls; reset each utterance.
            voice.model.token_hop_len = 25
            # Buffered output is peak-normalized below; clipping first destroys those peaks.
            voice.model.hift.audio_limit = vocoder_audio_limit if stream else float("inf")
            with torch.inference_mode():
                for x in voice.inference_zero_shot(
                    text, prompt, reference, zero_shot_spk_id="feiyu-cute" if cache_reference else "",
                    stream=stream, speed=1.0 if stream else 1.2, text_frontend=True):
                    chunk = x["tts_speech"].detach().cpu().numpy()[0]
                    if not np.isfinite(chunk).all():
                        raise ValueError("Invalid generated audio")
                    chunks.append(chunk)
                    if stream and len(chunk):
                        pcm = (np.clip(chunk, -.98, .98) * 32767).astype("<i2").tobytes()
                        connection.send(("chunk", (pcm, voice.sample_rate)))
            audio = np.concatenate(chunks)
            if denoise:
                audio = denoise_audio(audio, voice.sample_rate)
            if len(audio) <= 2400 or not np.isfinite(audio).all() or abs(audio).max() <= 1e-4:
                raise ValueError("Invalid generated audio")
            gain = min(1.0, .98 / float(abs(audio).max()))
            output = io.BytesIO()
            sf.write(output, audio * gain, voice.sample_rate, format="WAV", subtype="PCM_16")
            connection.send(("audio", (output.getvalue(), {"synthesis_seconds": time.perf_counter() - started,
                "audio_seconds": len(audio) / voice.sample_rate, "gain": gain,
                "denoise": denoise,
                "text_frontend": voice.frontend.text_frontend})))
    except Exception as error:
        import traceback
        traceback.print_exc()
        connection.send(("error", type(error).__name__ + ": " + str(error)))
    finally:
        connection.close()


class VoiceEngine:
    def __init__(self, package, source, target=worker, timeout=100, cache_reference=True):
        self.package, self.source = str(Path(package).resolve()), str(Path(source).resolve())
        self.target, self.timeout = target, timeout
        self.cache_reference = cache_reference
        self.process = self.connection = None
        self.load_seconds = 0

    def _receive(self, cancel, deadline):
        while True:
            if cancel.is_set():
                raise SynthesisCancelled()
            if time.monotonic() > deadline:
                raise TimeoutError("Feiyu worker deadline exceeded")
            if self.connection.poll(.025):
                kind, value = self.connection.recv()
                if kind == "error":
                    raise RuntimeError(value)
                return kind, value
            if not self.process.is_alive():
                raise RuntimeError("Feiyu worker exited")

    def warmup(self, cancel=None, deadline=None):
        if self.process is not None and self.process.is_alive():
            return
        self.close()
        started = time.perf_counter()
        context = mp.get_context("spawn")
        self.connection, child = context.Pipe()
        self.process = context.Process(target=self.target, args=(child, self.package, self.source, self.cache_reference), daemon=True)
        self.process.start()
        child.close()
        try:
            kind, _ = self._receive(cancel or threading.Event(), deadline or time.monotonic() + self.timeout)
            if kind != "ready":
                raise RuntimeError("Unexpected worker startup response")
            self.load_seconds = time.perf_counter() - started
        except BaseException:
            self.close()
            raise

    def synthesize(self, text, speaker="cute", cancel=None, on_chunk=None):
        if speaker != "cute" or not isinstance(text, str) or not text.strip() or len(text) > 500:
            raise ValueError("Expected cute voice and 1–500 characters")
        cancel = cancel or threading.Event()
        deadline = time.monotonic() + self.timeout
        if cancel.is_set():
            raise SynthesisCancelled()
        try:
            self.warmup(cancel, deadline)
            self.connection.send((text, on_chunk is not None))
            # Upstream generation threads cannot cancel cooperatively. Drain this
            # bounded job while the queue retains its GPU slot; never reuse stale audio.
            kind, result = self._receive(threading.Event(), deadline)
            while kind == "chunk":
                if not cancel.is_set():
                    on_chunk(*result)
                kind, result = self._receive(threading.Event(), deadline)
            if kind != "audio":
                raise RuntimeError("Unexpected worker response")
        except BaseException:
            self.close()
            raise
        if cancel.is_set():
            raise SynthesisCancelled()
        return result

    def close(self):
        if self.process is not None:
            if self.process.is_alive():
                self.process.terminate()
            self.process.join(timeout=3)
            if self.process.is_alive():
                self.process.kill()
                self.process.join()
            self.process.close()
            self.process = None
        if self.connection is not None:
            self.connection.close()
            self.connection = None
