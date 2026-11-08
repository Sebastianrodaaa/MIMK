# mimk-sim (private MiroFish backend)

Deploy: `fly deploy --dockerfile deploy/mirofish/Dockerfile services/mirofish` (build context is `services/mirofish`; the app must already exist: `fly apps create mimk-sim`).

Secrets (set once, never in the image): `fly secrets set LLM_API_KEY=… LLM_BASE_URL=… LLM_MODEL_NAME=… ZEP_API_KEY=… -a mimk-sim`. The volume `mimk_sim_data` (create with `fly volumes create mimk_sim_data --size 1 -a mimk-sim`) persists `backend/uploads` across scale-to-zero stops.

The orchestrator reaches it over the Fly private network via flycast / the app's private IPv6 (`mimk-sim.flycast` or `.internal`) — set `MIROFISH_URL` + `MIROFISH_LAZY=1` on `mimk-demo` so cold starts (30–90s) are woken by epoch requests instead of probed at boot.
