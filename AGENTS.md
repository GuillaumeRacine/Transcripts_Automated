This repository is used with Codex CLI.

Instructions for agents:

- Always load environment variables from `.env.local` at startup. Do not hardcode secrets.
- Keep changes minimal and focused on the requested task.
- Outputs go to `output/` and state to `data/state.json`.
- Do not commit `.env.local` or `data/state.json`.

