"""Selected Feiyu cute voice, using the existing bounded WAV service contract."""
import argparse
from pathlib import Path
import sys
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "Qwen3TTS"))
from cuda_server import create_app
from engine import VoiceEngine


class Speech(BaseModel):
    model_config = ConfigDict(extra="forbid")
    input: str = Field(min_length=1, max_length=500)
    voice: Literal["cute"] = "cute"
    stream: bool = False


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--port", type=int, default=18882)
    args = parser.parse_args()
    import uvicorn
    engine = VoiceEngine(args.model, args.source)
    try:
        engine.warmup()
        uvicorn.run(create_app(engine, Speech, ["cute"]), host="127.0.0.1", port=args.port, access_log=False)
    finally:
        engine.close()
