# MIMK

Hackathon prototype: a web GUI + CLI that spawn sandboxed Linux-desktop
computer-use agents (via [agent-desktop](https://github.com/vercel-labs/agent-desktop))
to research opt-in volunteers and public figures using public data only.
Dossiers feed twin personas -> MiroFish simulation -> a Phaser pixel world.

## Layout

- `packages/shared` — types, zod schemas, sensitive-data filter
- `packages/twin` — dossier builder + persona builder (LLM or deterministic fixtures)
- `apps/orchestrator` — Express API: subjects, runs (agent containers + VNC),
  dossiers/twins, chat, sim event SSE; SQLite at `apps/orchestrator/data/mimk.db`
- `apps/web` — Next.js UI: `/` chat console, `/subjects/[id]` VNC grid,
  `/world` Phaser pixel world
- `apps/cli` — `mimk` CLI
- `runtime/agent-image` — agent container: Xvfb + openbox + Firefox (mozillateam PPA)
  + agent-desktop + x11vnc + noVNC (port 6080)
- `fixtures/` — 3 fictional opted-in subjects (Ada Voss, Marco Lenz, Iris Tanaka)
  with findings, dossiers, personas, and 60 replay sim events

## Two-minute demo script

```sh
cp .env.example .env           # OFFLINE=1 works with zero LLM keys
npm install
docker build -t mimk-agent runtime/agent-image
npm run dev -w apps/orchestrator   # :4000, seeds fixtures automatically
npm run dev -w apps/web            # :3000
```

0:00 — open `http://localhost:3000` and ask the chat to research a person
       (e.g. "research Ada Voss with 2 agents"); agents spawn as live desktops
       in the chat (max 4 per task, capped overall by `MAX_PARALLEL`).
0:50 — `POST /subjects/:id/dossier` then `/subjects/:id/twin` (or use the CLI /
       cached fixtures: fixtures are auto-seeded at startup, so `/twins` is
       already populated offline).
1:10 — open `http://localhost:3000/world` — personas wander the town and replay
       `fixtures/sim-events.json` as speech bubbles (1x/2x/4x). Click a
       character to chat; type in "Inject event" to make everyone react.
1:50 — switch the world dropdown to `live (SSE)` to read `GET /sim/events`.

## Pre-run / caching

Dossiers and twins persist in SQLite, so you can generate them ahead of the
demo and the UI reads them instantly. With `OFFLINE=1` or no `MODEL_BASE_URL`,
persona building and chat use deterministic canned logic — everything still works.

## Key env vars

| var | meaning |
|---|---|
| `MODEL_BASE_URL`/`MODEL_NAME`/`MODEL_API_KEY` | OpenAI-compatible endpoint for agents. Defaults target the H Company Models API: `https://api.hcompany.ai/v1`, model `holo3-1-35b-a3b` (free tier, 10 req/min). Get a key at https://platform.hcompany.ai. Faster paid models: `holo4-35b-a3b`, `holo4-27b` |
| `TWIN_MODEL_*` | override for persona/chat calls (falls back to `MODEL_*`) |
| `MAX_PARALLEL` | cap on concurrently running agent containers (default 4) |
| `AGENT_BACKEND` | backend for agents spawned from the chat: `docker` (local desktop containers, default) or `h` (H cloud agents). Chat spawns at most 4 agents per request. Finished containers linger `LINGER_S` seconds (default 90) so the final desktop stays viewable. 4 parallel agents exceed the Holo free tier (10 req/min) — use a paid model (`holo4-35b-a3b`) for parallel runs |
| `MAX_STEPS`, `STEP_DELAY_MS` | agent loop controls |
| `OFFLINE=1` | force fixture/canned mode, no LLM calls |
| `FIXTURES_DIR` | default `../../fixtures` relative to orchestrator |
| `MIROFISH_URL` | if set, `/sim/events` uses the MiroFish backend instead of replay |
| `NEXT_PUBLIC_ORCHESTRATOR_URL`, `NEXT_PUBLIC_VNC_HOST` | web wiring |

## MiroFish bridge

MiroFish (https://github.com/666ghj/MiroFish, cloned to `services/mirofish`,
gitignored) is a Flask backend (`/api/graph`, `/api/simulation`, `/api/report`)
that builds an agent society from a seed document and simulates it.

Setup (Python 3.12 via uv — the system Python is too new):

```bash
bash scripts/setup-mirofish.sh   # clones if needed, writes services/mirofish/.env
cd services/mirofish/backend && .venv/bin/python run.py   # serves :5001
```

Then in root `.env` set `MIROFISH_URL=http://localhost:5001` (and a real
`ZEP_API_KEY` — free tier at https://app.getzep.com) and restart the
orchestrator. `apps/orchestrator/src/sim.ts` `MirofishBackend` drives the real
pipeline: ontology/generate -> graph build -> simulation create/prepare/start
(capped by `MIROFISH_MAX_ROUNDS`, default 10) -> maps `/posts` + `/actions`
into world events, and `/twins/:id/chat` proxies to MiroFish `/interview`.
Without `MIROFISH_URL` (or if the service is unreachable / keys missing) the
world falls back to the replay fixture and `/status` says why.

Verified locally: backend boots on Python 3.12 and `/api/simulation/list`
answers. A real simulation needs real `ZEP_API_KEY` + `LLM_API_KEY`.

## Test it

```bash
npm run dev:all     # orchestrator :4000 + web :3001 (3000 if free)
npm run smoke       # 6-check end-to-end in offline mode
npm run smoke -- --live   # also fires one real H Agents API session
```

Flow: ask the chat to research a person -> agents spawn
(docker+agent-desktop desktops, or H Agents API sessions when `HAI_API_KEY`
is set) -> findings persist to SQLite -> "Build twin" -> persona appears in
`/world` -> click a character to chat, "Inject event" for god-mode.

Keys: `HAI_API_KEY`/`MODEL_API_KEY` unlocks H Agents API + Holo models
(free tier `holo3-1-35b-a3b`, get key at https://platform.hcompany.ai);
`ZEP_API_KEY` unlocks real MiroFish simulations.

## OSINT tools list

`runtime/agent-image/tools.json` is generated from the OSINT Tools Library
(curated to free, no-login, professional-footprint tools):

```sh
git clone --depth 1 -b GitBook https://github.com/The-OSINT-Newsletter/OSINT-Tools-Library services/osint-tools-library
npm run sync:osint
```
