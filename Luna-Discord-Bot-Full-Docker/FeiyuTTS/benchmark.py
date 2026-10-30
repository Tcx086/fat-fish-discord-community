"""Opt-in local synthetic benchmark; never connects to Discord or an LLM."""
import argparse
import json
from pathlib import Path
import threading
import time
import wave

from engine import VoiceEngine, SynthesisCancelled


def benchmark(args):
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    engine = VoiceEngine(args.model, args.source, cache_reference=not args.uncached_reference)
    rows = []
    try:
        engine.warmup()
        pid = engine.process.pid
        texts = {"short": "第一项安排是去公园。", "long": "保护环境可以减少污染，让大家呼吸更清新的空气。节约资源也能保护动植物的家园。我们可以从垃圾分类和减少浪费做起。"}
        for repeat in range(3):
            for name, text in texts.items():
                for streaming in (False, True):
                    chunks, arrivals = [], []
                    started = time.perf_counter()
                    def receive(pcm, rate):
                        assert rate == 24000 and len(pcm) % 2 == 0
                        chunks.append(pcm)
                        arrivals.append({"at": time.perf_counter() - started, "seconds": len(pcm) / 48000})
                    data, stats = engine.synthesize(text, on_chunk=receive if streaming else None)
                    elapsed = time.perf_counter() - started
                    assert engine.process.pid == pid and data[:4] == b"RIFF"
                    row = {"repeat": repeat, "name": name, "stream": streaming, "first": arrivals[0]["at"] if arrivals else elapsed, "total": elapsed, "chunks": arrivals, **stats}
                    rows.append(row)
                    print(json.dumps(row), flush=True)
                    if repeat == 0:
                        if streaming:
                            with wave.open(str(output / (name + "-stream.wav")), "wb") as wav:
                                wav.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
                                wav.writeframes(b"".join(chunks))
                        else:
                            (output / (name + "-buffered.wav")).write_bytes(data)
        cancel = threading.Event()
        timer = threading.Timer(.3, cancel.set)
        started = time.perf_counter()
        timer.start()
        try:
            engine.synthesize(texts["long"], cancel=cancel)
            raise AssertionError("Expected cancellation")
        except SynthesisCancelled:
            drained = time.perf_counter() - started
        finally:
            timer.join()
        assert engine.process.pid == pid
        started = time.perf_counter()
        engine.synthesize(texts["short"])
        recovered = time.perf_counter() - started
        assert engine.process.pid == pid
        result = {"cached_reference": not args.uncached_reference, "load_seconds": engine.load_seconds, "rows": rows, "cancel": {"trigger_seconds": .3, "drain_seconds": drained, "next_seconds": recovered, "worker_reused": True}}
        (output / "feiyu.json").write_text(json.dumps(result, indent=2))
        print(json.dumps(result["cancel"]), flush=True)
    finally:
        engine.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--uncached-reference", action="store_true")
    benchmark(parser.parse_args())
