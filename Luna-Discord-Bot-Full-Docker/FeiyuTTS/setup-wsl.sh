#!/usr/bin/env bash
set -euo pipefail
root="${FEIYU_RUNTIME_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/feiyu-cute}"
here=$(cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$root"
if [ ! -x "$root/bootstrap/bin/uv" ]; then
  python3 -m venv "$root/bootstrap"
  "$root/bootstrap/bin/python" -m pip install uv==0.13.5
fi
uv="$root/bootstrap/bin/uv"
if [ ! -d "$root/source/.git" ]; then
  git clone --no-checkout https://github.com/FunAudioLLM/CosyVoice.git "$root/source"
  git -C "$root/source" checkout --detach 074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc
  git -C "$root/source" submodule update --init --recursive
fi
test "$(git -C "$root/source" rev-parse HEAD)" = 074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc
if [ ! -x "$root/venv/bin/python" ]; then
  "$uv" venv --python 3.11 "$root/venv"
fi
"$uv" pip install --python "$root/venv/bin/python" --index-url https://download.pytorch.org/whl/cu128 --index https://pypi.org/simple --index-strategy unsafe-best-match torch==2.11.0+cu128 torchaudio==2.11.0+cu128
printf 'torch==2.11.0+cu128\ntorchaudio==2.11.0+cu128\n' > "$root/constraints.txt"
"$uv" pip install --python "$root/venv/bin/python" -c "$root/constraints.txt" -r "$here/requirements.txt"
"$uv" pip install --python "$root/venv/bin/python" --index-url https://download.pytorch.org/whl/cpu torchcodec==0.11.0+cpu
"$uv" pip check --python "$root/venv/bin/python"
"$uv" pip freeze --python "$root/venv/bin/python" > "$root/requirements-resolved.txt"
