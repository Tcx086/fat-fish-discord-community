"""Real loopback synthesis checks; saves two new utterances for listening."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import time
import urllib.request
import wave


def main(destination):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    results = []
    for name, text in [("selected", "好呀，以后就用这个声音陪你聊天。今天想聊点什么？"),
                       ("mixed", "我看看，Discord 的语音延迟现在怎么样？")]:
        request = urllib.request.Request("http://127.0.0.1:18882/v1/audio/speech",
            data=json.dumps({"input": text, "voice": "cute", "stream": False}).encode(),
            headers={"Content-Type": "application/json"})
        started = time.perf_counter()
        with urllib.request.urlopen(request, timeout=120) as response:
            assert response.headers.get_content_type() == "audio/wav"
            synthesis = float(response.headers["X-Synthesis-Seconds"])
            data = response.read()
        elapsed = time.perf_counter() - started
        with wave.open(io.BytesIO(data)) as wav:
            assert wav.getnchannels() == 1 and wav.getsampwidth() == 2 and wav.getframerate() == 24000
            seconds = wav.getnframes() / wav.getframerate()
            assert seconds > .1
        (destination / (name + ".wav")).write_bytes(data)
        results.append(dict(name=name, text=text, bytes=len(data), sha256=hashlib.sha256(data).hexdigest(),
                            audio_seconds=seconds, synthesis_seconds=synthesis, elapsed_seconds=elapsed,
                            real_time_factor=synthesis / seconds, sample_rate=24000, voice="cute", seed=42))
        print(json.dumps(results[-1], ensure_ascii=False), flush=True)
    (destination / "manifest.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("destination")
    main(parser.parse_args().destination)
