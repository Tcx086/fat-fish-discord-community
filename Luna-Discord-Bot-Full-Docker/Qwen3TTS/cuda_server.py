"""Loopback-only, bounded FIFO adapter. Returns a complete PCM16 WAV per sentence."""
import argparse
import asyncio
from contextlib import asynccontextmanager
import threading
import time
from typing import Literal

from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from cuda_voice import SynthesisCancelled, VoiceEngine


class Speech(BaseModel):
    model_config = ConfigDict(extra="forbid")
    input: str = Field(min_length=1, max_length=500)
    voice: Literal["Vivian", "Serena"] = "Vivian"
    language: Literal["Auto", "Chinese", "English"] = "Auto"
    expression: str = Field(default="neutral", max_length=64)
    instruct: str | None = Field(default=None, max_length=500)
    seed: int = Field(default=42, ge=0, le=2**32 - 1)
    stream: bool = False


class SynthQueue:
    def __init__(self, engine, capacity=4):
        self.engine, self.capacity = engine, capacity
        self.lock = asyncio.Lock()
        self.pending = 0
        self.closed = False
        self.events = set()

    async def run(self, speech, cancel):
        if self.closed:
            raise HTTPException(503, "Service stopping")
        if self.pending >= self.capacity:
            raise HTTPException(429, "Synthesis queue full")
        self.pending += 1
        self.events.add(cancel)
        try:
            async with self.lock:
                if cancel.is_set():
                    raise SynthesisCancelled()
                args = speech.model_dump(exclude={"input", "voice", "stream"})
                work = asyncio.create_task(asyncio.to_thread(self.engine.synthesize,
                    speech.input, speaker=speech.voice, cancel=cancel, **args))
                try:
                    return await asyncio.shield(work)
                finally:
                    cancel.set()
                    # Do not release the GPU slot while a cancelled thread still owns it.
                    try:
                        await asyncio.shield(work)
                    except Exception:
                        pass
        finally:
            self.events.discard(cancel)
            self.pending -= 1

    async def close(self):
        self.closed = True
        for event in self.events:
            event.set()
        async with self.lock:
            await asyncio.to_thread(self.engine.close)


def create_app(engine, speech_model=Speech, speakers=None):
    queue = SynthQueue(engine)
    @asynccontextmanager
    async def lifespan(app):
        yield
        await queue.close()

    app = FastAPI(lifespan=lifespan)
    app.state.queue = queue

    @app.get("/health")
    async def health():
        return {"ready": not queue.closed, "pending": queue.pending, "capacity": queue.capacity,
                "streaming": False, "speakers": speakers or ["Vivian", "Serena"],
                "load_seconds": engine.load_seconds}

    @app.post("/v1/audio/speech")
    async def speech(body: speech_model, request: Request):
        if not body.input.strip():
            raise HTTPException(422, "Empty spoken text")
        if body.stream:
            raise HTTPException(400, "Use stream=false; this adapter returns complete sentences")
        cancel = threading.Event()
        task = asyncio.create_task(queue.run(body, cancel))
        started = time.perf_counter()
        try:
            while not task.done():
                if await request.is_disconnected():
                    raise HTTPException(499, "Client disconnected")
                if time.perf_counter() - started > 110:
                    raise HTTPException(504, "Request deadline exceeded")
                await asyncio.wait({task}, timeout=0.05)
            data, stats = await task
            return Response(data, media_type="audio/wav", headers={
                "X-Synthesis-Seconds": str(stats["synthesis_seconds"]), "Cache-Control": "no-store"})
        except SynthesisCancelled:
            raise HTTPException(499, "Synthesis cancelled")
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503, "Local synthesis failed")
        finally:
            cancel.set()
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--port", type=int, default=18881)
    args = parser.parse_args()
    import uvicorn
    engine = VoiceEngine(args.model)
    uvicorn.run(create_app(engine), host="127.0.0.1", port=args.port, access_log=False)
