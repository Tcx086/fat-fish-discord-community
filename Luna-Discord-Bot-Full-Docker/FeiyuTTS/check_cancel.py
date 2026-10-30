"""Opt-in real HTTP disconnect test; does not log in to Discord."""
import json
from pathlib import Path
import time
import httpx


if __name__ == "__main__":
    with httpx.Client(trust_env=False, timeout=5) as client:
        url = "http://127.0.0.1:18882"
        before = client.get(url + "/health").json()
        assert before["ready"] and before["pending"] == 0
        try:
            client.post(url + "/v1/audio/speech", json={"input": "先让我看看这个问题，我们慢慢来，一步一步把它解决掉。", "voice": "cute"}, timeout=.3)
            raise AssertionError("Expected a timeout during active synthesis")
        except httpx.ReadTimeout:
            disconnected = time.perf_counter()
        # Cancellation discards output but holds the slot until the bounded job finishes.
        deadline = time.monotonic() + 110
        while client.get(url + "/health").json()["pending"]:
            assert time.monotonic() < deadline, "GPU queue did not drain"
            time.sleep(.05)
        drained = time.perf_counter() - disconnected
        started = time.perf_counter()
        response = client.post(url + "/v1/audio/speech", json={"input": "第一项安排是去公园。", "voice": "cute"}, timeout=110)
        response.raise_for_status()
        assert response.content.startswith(b"RIFF")
        after = client.get(url + "/health").json()
        assert before["load_seconds"] == after["load_seconds"], "Model reloaded after cancellation"
        assert after["pending"] == 0
        result = {"queue_empty_after_disconnect_seconds": drained,
                  "next_audio_seconds": time.perf_counter() - started, "load_seconds_unchanged": True}
        print(json.dumps(result), flush=True)
        path = Path(__file__).resolve().parents[1] / "Luna/voice-eval/feiyu-cute/cancel.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(result, indent=2))
