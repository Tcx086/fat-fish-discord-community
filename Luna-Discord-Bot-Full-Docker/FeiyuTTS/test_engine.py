import asyncio
import threading
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from fastapi.testclient import TestClient
from engine import VoiceEngine, SynthesisCancelled, denoise_audio
from server import Speech, create_app
from cuda_server import SynthQueue


def fake_worker(connection, package, source, cache_reference):
    connection.send(("ready", None))
    while True:
        text, stream = connection.recv()
        if text == "hang":
            time.sleep(60)
        elif text == "fail":
            connection.send(("error", "failed"))
        else:
            if stream:
                connection.send(("chunk", (text.encode(), 24000)))
            if text == "slow":
                time.sleep(.3)
            connection.send(("audio", (b"RIFF-test" if text == "你好" else text.encode(), {"synthesis_seconds": .01})))


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.engine = VoiceEngine(".", ".", target=fake_worker, timeout=10)
        self.addCleanup(self.engine.close)

    def test_stream_cancel_drains_without_stale_chunks(self):
        cancel = threading.Event()
        chunks = []
        def receive(pcm, rate):
            chunks.append((pcm, rate))
            cancel.set()
        self.engine.warmup()
        pid = self.engine.process.pid
        with self.assertRaises(SynthesisCancelled):
            self.engine.synthesize("slow", cancel=cancel, on_chunk=receive)
        self.assertEqual(chunks, [(b"slow", 24000)])
        self.assertEqual(self.engine.process.pid, pid)
        self.engine.synthesize("next", on_chunk=lambda pcm, rate: chunks.append((pcm, rate)))
        self.assertEqual(chunks[-1], (b"next", 24000))

    def test_callback_failure_cannot_leave_an_unread_job(self):
        def failed_callback(pcm, rate):
            raise SynthesisCancelled()
        with self.assertRaises(SynthesisCancelled):
            self.engine.synthesize("slow", on_chunk=failed_callback)
        self.assertIsNone(self.engine.process)
        self.assertEqual(self.engine.synthesize("next")[0], b"next")

    def test_reuses_worker_and_recovers_after_cancel(self):
        started = time.perf_counter()
        self.engine.warmup()
        cold = time.perf_counter() - started
        pid = self.engine.process.pid
        started = time.perf_counter()
        self.assertEqual(self.engine.synthesize("one")[0], b"one")
        warm = time.perf_counter() - started
        self.engine.synthesize("two")
        self.assertEqual(self.engine.process.pid, pid)
        cancel = threading.Event()
        timer = threading.Timer(.1, cancel.set)
        timer.start()
        started = time.perf_counter()
        try:
            with self.assertRaises(SynthesisCancelled):
                self.engine.synthesize("slow", cancel=cancel)
        finally:
            timer.join()
        self.assertEqual(self.engine.process.pid, pid)
        cancelled = time.perf_counter() - started
        started = time.perf_counter()
        self.assertEqual(self.engine.synthesize("recovered")[0], b"recovered")
        reload = time.perf_counter() - started
        self.assertEqual(self.engine.process.pid, pid)
        with self.assertRaises(SynthesisCancelled):
            self.engine.synthesize("not sent", cancel=cancel)
        self.assertEqual(self.engine.process.pid, pid)
        print(f"Synthetic worker only (no model): cold={cold:.3f}s warm={warm:.3f}s "
              f"cancel_including_100ms_trigger={cancelled:.3f}s reload={reload:.3f}s", flush=True)

    def test_timeout_error_and_validation(self):
        self.engine.warmup()
        self.engine.timeout = .1
        with self.assertRaises(TimeoutError):
            self.engine.synthesize("hang")
        self.assertIsNone(self.engine.process)
        self.engine.timeout = 10
        self.engine.warmup()
        self.engine.timeout = .2
        cancel = threading.Event()
        timer = threading.Timer(.05, cancel.set)
        timer.start()
        try:
            with self.assertRaises(TimeoutError):
                self.engine.synthesize("hang", cancel=cancel)
        finally:
            timer.join()
        self.assertIsNone(self.engine.process)
        self.engine.timeout = 10
        with self.assertRaises(RuntimeError):
            self.engine.synthesize("fail")
        self.assertIsNone(self.engine.process)
        for text, speaker in [(" ", "cute"), ("x" * 501, "cute"), ("hello", "gentle")]:
            with self.assertRaises(ValueError):
                self.engine.synthesize(text, speaker=speaker)

    def test_http_contract_keeps_selected_voice(self):
        with TestClient(create_app(self.engine, Speech, ["cute"])) as client:
            self.assertEqual(client.get("/health").json()["speakers"], ["cute"])
            self.assertEqual(client.post("/v1/audio/speech", json={"input": "你好"}).content, b"RIFF-test")
            for payload in [{"input": "hello", "voice": "gentle"}, {"input": " "},
                            {"input": "hello", "expression": "happy"}]:
                self.assertEqual(client.post("/v1/audio/speech", json=payload).status_code, 422)
            self.assertEqual(client.post("/v1/audio/speech", json={"input": "hi", "stream": True}).status_code, 400)
            self.assertEqual(client.post("/v1/audio/speech", json={"input": "fail"}).status_code, 503)
        self.assertIsNone(self.engine.process)


class DenoiseTests(unittest.TestCase):
    def test_reduces_noise_without_shifting_or_cutting_speech(self):
        import numpy as np
        rate = 24000
        t = np.arange(rate * 2) / rate
        tone = (.18 * np.sin(2 * np.pi * 220 * t) + .08 * np.sin(2 * np.pi * 660 * t))
        speech = (t > .3) & (t < 1.9)
        audio = tone * speech + np.random.default_rng(42).normal(0, .001, len(t))
        result = denoise_audio(audio, rate)
        self.assertEqual(result.shape, audio.shape)
        quiet = (t > .1) & (t < .25)
        self.assertLess(np.mean(result[quiet] ** 2), np.mean(audio[quiet] ** 2) * .5)
        interior = (t > .4) & (t < 1.8)
        self.assertGreater(np.corrcoef(result[interior], audio[interior])[0, 1], .995)
        self.assertGreater(np.mean(result[(t > 1.8) & (t < 1.89)] ** 2), .01)

    def test_invalid_input_and_failed_filter_fail_closed(self):
        import numpy as np
        import subprocess
        with self.assertRaises(ValueError):
            denoise_audio(np.array([float('nan')]), 24000)
        with self.assertRaises(ValueError):
            denoise_audio(np.ones(100), 48000)
        with patch('engine.subprocess.run', side_effect=subprocess.TimeoutExpired('ffmpeg', 10)):
            with self.assertRaisesRegex(RuntimeError, 'noise reduction failed'):
                denoise_audio(np.ones(100), 24000)
        with patch('engine.subprocess.run', return_value=SimpleNamespace(stdout=b'')):
            with self.assertRaisesRegex(ValueError, 'length'):
                denoise_audio(np.ones(100), 24000)


class DrainQueueTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_job_holds_slot_until_drained(self):
        engine = VoiceEngine(".", ".", target=fake_worker, timeout=10)
        queue = SynthQueue(engine)
        try:
            await asyncio.to_thread(engine.warmup)
            pid = engine.process.pid
            first = asyncio.create_task(queue.run(Speech(input="slow"), threading.Event()))
            await asyncio.sleep(.1)
            first.cancel()
            next_job = asyncio.create_task(queue.run(Speech(input="next"), threading.Event()))
            await asyncio.sleep(.05)
            self.assertFalse(next_job.done())
            self.assertEqual(queue.pending, 2)
            await asyncio.gather(first, return_exceptions=True)
            self.assertEqual((await next_job)[0], b"next")
            self.assertEqual(engine.process.pid, pid)
            self.assertEqual(queue.pending, 0)
        finally:
            await queue.close()


if __name__ == "__main__":
    unittest.main()
