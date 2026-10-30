import asyncio
import io
import threading
import unittest

from fastapi import HTTPException
from fastapi.testclient import TestClient
import numpy as np
from pydantic import ValidationError
import soundfile as sf

from cuda_server import Speech, SynthQueue, create_app
from cuda_voice import EXPRESSIONS, SynthesisCancelled, VoiceEngine, instruction, wav_bytes


class FakeEngine:
    load_seconds = 0
    def __init__(self):
        self.seen = []
        self.started = threading.Event()
        self.release = threading.Event()
        self.cancelled = threading.Event()
        self.closed = False

    def synthesize(self, text, cancel, **kwargs):
        self.seen.append((text, kwargs))
        self.started.set()
        while not self.release.wait(0.005):
            if cancel.is_set():
                self.cancelled.set()
                raise SynthesisCancelled()
        if text == "fail":
            raise RuntimeError("test failure")
        return wav_bytes(np.zeros(240), 24000), {"synthesis_seconds": 0.01}

    def close(self):
        self.closed = True


class VoiceTests(unittest.TestCase):
    def test_expression_mapping_and_fallback(self):
        self.assertEqual(len(EXPRESSIONS), 7)
        self.assertEqual(len(set(EXPRESSIONS.values())), 7)
        for label, direction in EXPRESSIONS.items():
            self.assertEqual(instruction(label), (label, direction))
        self.assertEqual(instruction("hostile"), instruction())
        self.assertEqual(instruction("curious", "Natural and curious."), ("curious", "Natural and curious."))

    def test_pcm16_conversion(self):
        data = wav_bytes(np.array([-2, -0.5, 0, 0.5, 2]), 24000)
        y, rate = sf.read(io.BytesIO(data))
        self.assertEqual(rate, 24000)
        self.assertEqual(sf.info(io.BytesIO(data)).subtype, "PCM_16")
        np.testing.assert_allclose(y, [-1, -0.5, 0, 0.5, 32767 / 32768])
        for invalid in ([], [float("nan")], [[0, 1]]):
            with self.assertRaises(ValueError):
                wav_bytes(invalid, 24000)

    def test_voice_language_validation(self):
        for text, language in [("你好。", "Chinese"), ("Hello.", "English"), ("Discord 延迟。", "Auto")]:
            self.assertEqual(Speech(input=text, language=language, voice="Serena").input, text)
        for args in ({"voice": "Ryan"}, {"language": "bad"}, {"seed": -1}, {"input": "x" * 501}):
            with self.assertRaises(ValidationError):
                Speech(**{"input": "test", **args})

    def test_missing_model_never_downloads(self):
        with self.assertRaises(FileNotFoundError):
            VoiceEngine("missing-customvoice-test-directory")

    def test_http_contract_and_cleanup(self):
        engine = FakeEngine()
        engine.release.set()
        with TestClient(create_app(engine)) as client:
            self.assertFalse(client.get("/health").json()["streaming"])
            result = client.post("/v1/audio/speech", json={"input": "你好 Discord。", "expression": "curious", "voice": "Serena"})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.content[:4], b"RIFF")
            self.assertEqual(engine.seen[0][0], "你好 Discord。")
            self.assertEqual(engine.seen[0][1]["expression"], "curious")
            self.assertEqual(client.post("/v1/audio/speech", json={"input": "x", "stream": True}).status_code, 400)
            self.assertEqual(client.post("/v1/audio/speech", json={"input": " "}).status_code, 422)
            self.assertEqual(client.post("/v1/audio/speech", json={"input": "fail"}).status_code, 503)
            self.assertEqual(client.get("/health").json()["pending"], 0)
        self.assertTrue(engine.closed)


class QueueTests(unittest.IsolatedAsyncioTestCase):
    async def wait_started(self, engine):
        self.assertTrue(await asyncio.to_thread(engine.started.wait, 2))

    async def test_order_capacity_and_recovery(self):
        engine = FakeEngine()
        queue = SynthQueue(engine, capacity=3)
        tasks = []
        for text in ["one", "two", "three"]:
            tasks.append(asyncio.create_task(queue.run(Speech(input=text), threading.Event())))
            await asyncio.sleep(0)
        await self.wait_started(engine)
        with self.assertRaises(HTTPException) as caught:
            await queue.run(Speech(input="overflow"), threading.Event())
        self.assertEqual(caught.exception.status_code, 429)
        engine.release.set()
        await asyncio.gather(*tasks)
        self.assertEqual([x[0] for x in engine.seen], ["one", "two", "three"])
        self.assertEqual(queue.pending, 0)
        await queue.close()
        self.assertTrue(engine.closed)

    async def test_active_and_waiting_cancellation(self):
        engine = FakeEngine()
        queue = SynthQueue(engine)
        first = asyncio.create_task(queue.run(Speech(input="active"), threading.Event()))
        await self.wait_started(engine)
        waiting = asyncio.create_task(queue.run(Speech(input="waiting"), threading.Event()))
        await asyncio.sleep(0)
        waiting.cancel()
        await asyncio.gather(waiting, return_exceptions=True)
        first.cancel()
        await asyncio.gather(first, return_exceptions=True)
        self.assertTrue(engine.cancelled.is_set())
        self.assertEqual(queue.pending, 0)
        self.assertEqual(len(engine.seen), 1)
        engine.release.set()
        await queue.run(Speech(input="next"), threading.Event())
        await queue.close()

    async def test_close_cancels_and_releases(self):
        engine = FakeEngine()
        queue = SynthQueue(engine)
        active = asyncio.create_task(queue.run(Speech(input="active"), threading.Event()))
        await self.wait_started(engine)
        await queue.close()
        await asyncio.gather(active, return_exceptions=True)
        self.assertTrue(engine.cancelled.is_set())
        self.assertTrue(engine.closed)
        with self.assertRaises(HTTPException):
            await queue.run(Speech(input="late"), threading.Event())

    async def test_http_disconnect_cancels_active_synthesis(self):
        engine = FakeEngine()
        app = create_app(engine)
        endpoint = next(route.endpoint for route in app.routes if route.path == "/v1/audio/speech")
        class Request:
            async def is_disconnected(self):
                return engine.started.is_set()
        with self.assertRaises(HTTPException) as caught:
            await endpoint(Speech(input="disconnect"), Request())
        self.assertEqual(caught.exception.status_code, 499)
        self.assertTrue(engine.cancelled.is_set())
        self.assertEqual(app.state.queue.pending, 0)
        await app.state.queue.close()


if __name__ == "__main__":
    unittest.main()
