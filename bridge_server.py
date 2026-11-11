#!/usr/bin/env python3
"""Zero-dependency local bridge server for Ollama + Antigravity Bridge."""

import argparse
import http.client
import json
import mimetypes
import pathlib
import subprocess
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_DIR = pathlib.Path(__file__).resolve().parent
DEFAULT_OLLAMA = "http://127.0.0.1:11434"
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".firebase", "dist", ".venv", "venv"}
MAX_FILE_BYTES = 256 * 1024

STATE = {
    "workspace": APP_DIR,
    "ollama_url": DEFAULT_OLLAMA,
}


def _default_workspace():
    scriptdesk = pathlib.Path.home() / "sd" / "SCRIPT.DESK-main"
    if scriptdesk.is_dir():
        return scriptdesk
    return APP_DIR


def _safe_rel_path(workspace: pathlib.Path, rel: str) -> pathlib.Path:
    clean = rel.lstrip("/\\")
    target = (workspace / clean).resolve()
    ws_resolved = workspace.resolve()
    if target != ws_resolved and ws_resolved not in target.parents:
        raise ValueError("Path outside workspace")
    return target


def _list_workspace_files(workspace: pathlib.Path, limit: int = 400):
    files = []
    for path in sorted(workspace.rglob("*")):
        if any(part in SKIP_DIRS for part in path.relative_to(workspace).parts):
            continue
        if path.is_file():
            files.append(
                {
                    "path": str(path.relative_to(workspace)).replace("\\", "/"),
                    "size": path.stat().st_size,
                }
            )
            if len(files) >= limit:
                break
    return files


def _read_antigravity_info(workspace: pathlib.Path):
    gemini_dir = pathlib.Path.home() / ".gemini" / "config"
    mcp_path = gemini_dir / "mcp_config.json"
    mcp_servers = {}
    if mcp_path.is_file():
        try:
            mcp_servers = json.loads(mcp_path.read_text(encoding="utf-8")).get("mcpServers", {})
        except Exception:
            mcp_servers = {}

    skills = []
    skills_dir = workspace / ".agents" / "skills"
    if skills_dir.is_dir():
        for skill_md in sorted(skills_dir.glob("*/SKILL.md")):
            skills.append(
                {
                    "name": skill_md.parent.name,
                    "path": str(skill_md.relative_to(workspace)).replace("\\", "/"),
                }
            )

    gemini_md = workspace / "GEMINI.md"
    return {
        "workspace": str(workspace),
        "hasGeminiMd": gemini_md.is_file(),
        "mcpConfigPath": str(mcp_path),
        "mcpServers": list(mcp_servers.keys()),
        "workspaceSkills": skills,
    }


class BridgeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[bridge] {self.address_string()} - {fmt % args}\n")

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _send_json(self, code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self._cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/health":
            return self._send_json(
                200,
                {
                    "ok": True,
                    "workspace": str(STATE["workspace"]),
                    "ollamaUrl": STATE["ollama_url"],
                },
            )

        if path == "/api/workspace/files":
            ws = STATE["workspace"]
            return self._send_json(200, {"workspace": str(ws), "files": _list_workspace_files(ws)})

        if path == "/api/workspace/read":
            qs = urllib.parse.parse_qs(parsed.query)
            rel = (qs.get("path") or [""])[0]
            if not rel:
                return self._send_json(400, {"error": "Missing path parameter"})
            try:
                target = _safe_rel_path(STATE["workspace"], rel)
                if not target.is_file():
                    return self._send_json(404, {"error": "File not found"})
                raw = target.read_bytes()
                truncated = len(raw) > MAX_FILE_BYTES
                text = raw[:MAX_FILE_BYTES].decode("utf-8", errors="replace")
                return self._send_json(
                    200,
                    {"path": rel, "content": text, "truncated": truncated, "bytes": len(raw)},
                )
            except Exception as exc:
                return self._send_json(400, {"error": str(exc)})

        if path == "/api/antigravity/info":
            return self._send_json(200, _read_antigravity_info(STATE["workspace"]))

        if path.startswith("/api/ollama/"):
            return self._proxy_ollama("GET", path[len("/api/ollama") :], None)

        return self._serve_static(path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/ollama/"):
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length > 0 else b""
            return self._proxy_ollama("POST", path[len("/api/ollama") :], raw)

        try:
            body = self._read_json_body()
        except Exception as exc:
            return self._send_json(400, {"error": f"Invalid JSON: {exc}"})

        if path == "/api/workspace/select":
            candidate = pathlib.Path(body.get("path", "")).expanduser()
            if not candidate.is_dir():
                return self._send_json(400, {"error": f"Not a directory: {candidate}"})
            STATE["workspace"] = candidate.resolve()
            return self._send_json(200, {"ok": True, "workspace": str(STATE["workspace"])})

        if path == "/api/tools/run":
            return self._run_allowlisted_tool(body.get("tool", ""))

        return self._send_json(404, {"error": "Unknown API endpoint"})

    def _run_allowlisted_tool(self, tool: str):
        ws = STATE["workspace"]
        if tool == "ollama_list":
            proc = subprocess.run(["ollama", "list"], capture_output=True, text=True, timeout=15)
            return self._send_json(
                200,
                {"ok": proc.returncode == 0, "output": (proc.stdout + proc.stderr).strip()},
            )

        if tool == "build_scriptdesk":
            build_py = ws / "scripts" / "build.py"
            if not build_py.is_file():
                return self._send_json(400, {"error": "scripts/build.py not found in active workspace"})
            proc = subprocess.run(
                [sys.executable, str(build_py)],
                cwd=str(ws),
                capture_output=True,
                text=True,
                timeout=60,
            )
            return self._send_json(
                200,
                {"ok": proc.returncode == 0, "output": (proc.stdout + proc.stderr).strip()},
            )

        return self._send_json(400, {"error": f"Tool not allowlisted: {tool}"})

    def _proxy_ollama(self, method: str, ollama_path: str, body: bytes | None):
        target = urllib.parse.urlparse(STATE["ollama_url"])
        host = target.hostname or "127.0.0.1"
        port = target.port or 11434
        conn = http.client.HTTPConnection(host, port, timeout=120)
        headers = {"Content-Type": "application/json"} if body is not None else {}
        try:
            conn.request(method, ollama_path, body=body, headers=headers)
            resp = conn.getresponse()
            self.send_response(resp.status)
            self._cors_headers()
            ctype = resp.getheader("Content-Type") or "application/json"
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()

            while True:
                chunk = resp.read(4096)
                if not chunk:
                    break
                self.wfile.write(f"{len(chunk):X}\r\n".encode("ascii"))
                self.wfile.write(chunk)
                self.wfile.write(b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except Exception as exc:
            self._send_json(502, {"error": f"Ollama proxy error: {exc}"})
        finally:
            conn.close()

    def _serve_static(self, req_path: str):
        rel = "index.html" if req_path in ("", "/") else req_path.lstrip("/")
        try:
            target = _safe_rel_path(APP_DIR, rel)
        except ValueError:
            return self._send_json(403, {"error": "Forbidden"})

        if not target.is_file() or target.name.startswith("."):
            return self._send_json(404, {"error": "Not found"})

        data = target.read_bytes()
        ctype, _ = mimetypes.guess_type(str(target))
        self.send_response(200)
        self._cors_headers()
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    parser = argparse.ArgumentParser(description="Run Ollama + Antigravity Bridge locally")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--workspace", type=str, default=str(_default_workspace()))
    args = parser.parse_args()

    ws = pathlib.Path(args.workspace).expanduser().resolve()
    STATE["workspace"] = ws if ws.is_dir() else APP_DIR

    server = ThreadingHTTPServer(("127.0.0.1", args.port), BridgeHandler)
    print(f"Ollama + Antigravity Bridge running at http://127.0.0.1:{args.port}")
    print(f"Workspace: {STATE['workspace']}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.server_close()


if __name__ == "__main__":
    main()
