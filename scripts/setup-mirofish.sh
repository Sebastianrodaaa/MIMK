#!/bin/bash
set -e
cd "$(dirname "$0")/.."
if [ ! -d services/mirofish/.git ]; then
  git clone --depth 1 https://github.com/666ghj/MiroFish services/mirofish
fi
cd services/mirofish
# map root .env values onto MiroFish's expected LLM_* vars (no values echoed)
python3 - <<'PY'
import re, pathlib
root = {}
for l in pathlib.Path("../../.env").read_text().splitlines():
    m = re.match(r"\s*([A-Za-z_][\w]*)\s*=\s*(.*)", l)
    if m and not l.strip().startswith("#"): root[m[1]] = m[2].strip().strip("'\"")
mf = pathlib.Path(".env")
env = {l.split("=",1)[0]: l.split("=",1)[1] for l in mf.read_text().splitlines() if "=" in l} if mf.exists() else {}
env["LLM_API_KEY"] = root.get("MODEL_API_KEY") or root.get("HAI_API_KEY", "")
env["LLM_BASE_URL"] = root.get("MODEL_BASE_URL", "")
env["LLM_MODEL_NAME"] = root.get("MODEL_NAME", "")
env.setdefault("ZEP_API_KEY", "")
mf.write_text("\n".join(f"{k}={v}" for k, v in env.items()) + "\n")
print("wrote services/mirofish/.env:",
      "LLM key", "set" if env["LLM_API_KEY"] else "EMPTY",
      "| LLM model", env["LLM_MODEL_NAME"] or "unset",
      "| ZEP_API_KEY", "set" if env["ZEP_API_KEY"] else "EMPTY (get one at app.getzep.com)")
PY
cd backend && uv venv --python 3.12 .venv 2>/dev/null || uv venv .venv
uv pip install -r requirements.txt --python .venv/bin/python 2>&1 | tail -2
echo "run: cd services/mirofish && .venv/bin/python -m app.run or see its README"
