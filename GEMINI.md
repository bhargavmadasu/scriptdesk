# Ollama + Antigravity Bridge — Project Rules

- **Zero external runtime dependencies:** Keep `index.html`, `styles.css`, `app.js`, and `bridge_server.py` free of external CDN scripts so the app works 100% offline and on GitHub Pages.
- **GitHub Pages compatibility:** Do not require a Node/build step for the web frontend (`index.html`, `styles.css`, `app.js`). Any edits to the frontend must work directly as static files.
- **Localhost security:** `bridge_server.py` must bind only to `127.0.0.1`, restrict workspace reads to the configured workspace root, and never expose arbitrary shell execution.
