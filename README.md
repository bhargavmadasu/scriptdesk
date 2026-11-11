# Ollama + Antigravity Bridge

A zero-dependency, offline-first web workspace that connects your **local Ollama models** (e.g. `qwen3:8b`), **local project files**, and **Antigravity customizations/tools**—ready to run locally or deploy on **GitHub Pages**.

## Features

- **100% Local AI via Ollama** — Streams responses from `http://localhost:11434`, distinguishes local vs `:cloud` models, and supports collapsible reasoning/thinking blocks.
- **Workspace File Context** — Open any local folder in Chrome/Edge (File System Access API) or via the local Python bridge, inspect files, and attach them directly into prompts.
- **Antigravity Bridge (`bridge_server.py`)** — Optional zero-dependency Python server on `http://127.0.0.1:8765` that:
  - Serves the app locally
  - Proxies Ollama requests (no CORS headaches)
  - Lists your Antigravity MCP servers (`~/.gemini/config/mcp_config.json`), workspace skills (`.agents/skills/`), and `GEMINI.md` rules
  - Lets you run safe allowlisted actions (e.g., check Ollama, run `scripts/build.py` if present)
- **GitHub Pages Ready** — Static HTML/CSS/JS frontend with `.github/workflows/pages.yml` included.

## Quick Start (Local)

1. Install [Ollama](https://ollama.com/download) and pull a local model:
   ```bash
   ollama pull qwen3:8b
   ```
2. Start the local bridge + web UI:
   ```bash
   python bridge_server.py
   ```
3. Open **http://127.0.0.1:8765** in your browser.

## Deploy to GitHub Pages

1. Create a new repository on GitHub (e.g. `ollama-antigravity-bridge`).
2. Upload all files in this folder (make sure `.github/workflows/pages.yml` is included).
3. In your GitHub repo go to **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. Your app will be live at `https://<your-username>.github.io/<repo-name>/`.

### Allow GitHub Pages to talk to local Ollama

When opening the app from `https://<your-username>.github.io`, set `OLLAMA_ORIGINS` once on your PC and restart Ollama:

- **Windows (PowerShell):**
  ```powershell
  [Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "*", "User")
  ```
  Then quit Ollama from the system tray and reopen it.
- **macOS:**
  ```bash
  launchctl setenv OLLAMA_ORIGINS "*"
  ```
- **Linux (systemd):** Add `Environment="OLLAMA_ORIGINS=*"` to the Ollama service override.

Alternatively, keep `python bridge_server.py` running locally—the GitHub Pages site will detect it automatically on `http://127.0.0.1:8765`!
