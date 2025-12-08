# Opencode Ollama-compat Serve

This small service exposes a minimal Ollama-compatible HTTP surface that forwards requests to the project's `opencode` helpers located in the `@hexafield/agent-workflow` package (`packages/agent/src/opencode.ts`).

Quick start

1. From the repo root, change into `serve`:

```bash
cd serve
```

2. Install dependencies:

```bash
npm install
```

3. Start the server:

```bash
npm start
```

The server listens on port `11434` by default.

API (minimal)

- `GET /v1/models` — returns a small model listing.
- `POST /api/generate` and `POST /v1/generate` — body should include `model` and `prompt` (or `prompts`). Optionally include `directory` to scope a session. Response JSON contains `id`, `model`, and `output` with the generated text.

Notes

- This wrapper uses `ts-node` loader at runtime to import TypeScript sources from the main project. Ensure you're running from the `serve` folder with the project root structure preserved.
- For development, set `PORT` env var to change the port.
