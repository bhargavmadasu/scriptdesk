---
name: ollama-bridge
description: >-
  Use this skill when working on the Ollama + Antigravity Bridge app
  (index.html, app.js, styles.css, bridge_server.py, or GitHub Pages deployment).
---

# Ollama + Antigravity Bridge

## Architecture

- `index.html`, `styles.css`, `app.js` — Static PWA frontend that talks to local Ollama (`http://localhost:11434`), uses the browser File System Access API for local files, and optionally connects to `bridge_server.py` (`http://127.0.0.1:8765`).
- `bridge_server.py` — Zero-dependency Python 3 local server serving the UI, proxying Ollama without CORS issues, reading workspace files, and inspecting Antigravity MCP/skill configs.
- `.github/workflows/pages.yml` — Deploys the static frontend to GitHub Pages on push to `main`.

## Run Locally

```powershell
python bridge_server.py
```

Open `http://127.0.0.1:8765` in your browser.
