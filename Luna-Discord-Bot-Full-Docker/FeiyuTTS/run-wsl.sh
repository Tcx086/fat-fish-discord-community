#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "$0")" && pwd)
root="${FEIYU_RUNTIME_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/feiyu-cute}"
python_lib=$("$root/venv/bin/python" -c 'import sys; print(sys.base_prefix + "/lib")')
export LD_LIBRARY_PATH="$python_lib:${LD_LIBRARY_PATH:-}"
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 OMP_NUM_THREADS=4
exec "$root/venv/bin/python" "$here/server.py" --source "$root/source" --model "${FEIYU_MODEL_DIR:-$here/../../models/feiyu-cosyvoice3}"
