"""
app.py — Switchboard backend with streaming support and security hardening.
"""

from flask import Flask, request, jsonify, render_template, Response, stream_with_context
from concurrent.futures import ThreadPoolExecutor
import queue
import threading
import time
import json
import re

import providers

app = Flask(__name__)

# ── Security: tighten response headers ──────────────────────────────────────
@app.after_request
def set_security_headers(resp):
    resp.headers["X-Content-Type-Options"]  = "nosniff"
    resp.headers["X-Frame-Options"]         = "DENY"
    resp.headers["Referrer-Policy"]         = "strict-origin-when-cross-origin"
    resp.headers["Permissions-Policy"]      = "microphone=(self)"
    # Only restrict script-src in production; allow 'unsafe-inline' for the fonts/styles
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data:; "
        "connect-src 'self';"
    )
    return resp


# ── Pages ────────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("home.html")

@app.route("/home")
def home():
    return render_template("home.html")

@app.route("/app")
def app_page():
    return render_template("index.html")   # the actual chat app

@app.route("/about")
def about():
    return render_template("about.html")


# ── Validation helpers ───────────────────────────────────────────────────────
MODEL_RE = re.compile(r'^[\w\-./: ]{1,120}$')

def _validate_line(line):
    """Return an error string or None."""
    if not isinstance(line, dict):
        return "Line must be an object"
    provider = line.get("provider", "")
    model    = line.get("model", "")
    api_key  = line.get("api_key", "")
    if provider not in providers.PROVIDER_STREAM_FUNCS:
        return f"Unknown provider '{provider}'"
    if not model or not MODEL_RE.match(model):
        return "Invalid model name"
    if not api_key or len(api_key) > 512:
        return "API key missing or too long"
    return None


# ── API ──────────────────────────────────────────────────────────────────────
@app.route("/api/chat", methods=["POST"])
def chat():
    data   = request.get_json(force=True, silent=True) or {}
    prompt = (data.get("prompt") or "").strip()
    lines  = data.get("lines") or []

    if not prompt:
        return jsonify({"error": "Prompt is empty"}), 400
    if len(prompt) > 32_000:
        return jsonify({"error": "Prompt too long (max 32 000 chars)"}), 400
    if not lines:
        return jsonify({"error": "No active lines selected"}), 400
    if len(lines) > 10:
        return jsonify({"error": "Too many lines (max 10)"}), 400

    for ln in lines:
        err = _validate_line(ln)
        if err:
            return jsonify({"error": err}), 400

    # Each line streams text chunks the moment they arrive from the provider,
    # rather than waiting for the whole reply before the browser sees anything.
    # Every line runs in its own thread and pushes events onto one shared
    # queue; the generator below just drains the queue and forwards events as
    # SSE frames, so fast lines render immediately and don't wait on slow ones.
    events = queue.Queue()
    SENTINEL = object()

    def run_one(line):
        line_id = str(line.get("id", ""))[:64]
        provider = line["provider"]
        model    = line["model"]
        api_key  = line["api_key"]
        history  = line.get("history") or []
        history = [
            {"role": m["role"], "content": str(m.get("content", ""))[:16_000]}
            for m in history
            if isinstance(m, dict) and m.get("role") in ("user", "assistant", "system")
        ][-40:]   # cap at last 40 messages
        messages = history + [{"role": "user", "content": prompt}]

        start = time.time()
        try:
            for chunk in providers.stream_model(provider, api_key, model, messages):
                events.put({"id": line_id, "type": "delta", "text": chunk})
            events.put({
                "id":         line_id,
                "type":       "done",
                "ok":         True,
                "latency_ms": int((time.time() - start) * 1000),
            })
        except Exception as exc:
            events.put({
                "id":         line_id,
                "type":       "done",
                "ok":         False,
                "error":      str(exc)[:400],
                "latency_ms": int((time.time() - start) * 1000),
            })

    def run_all():
        with ThreadPoolExecutor(max_workers=min(len(lines), 10)) as ex:
            futures = [ex.submit(run_one, ln) for ln in lines]
            for fut in futures:
                fut.result()
        events.put(SENTINEL)

    def generate():
        threading.Thread(target=run_all, daemon=True).start()
        while True:
            item = events.get()
            if item is SENTINEL:
                break
            yield f"data: {json.dumps(item)}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control":    "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


if __name__ == "__main__":
    app.run(debug=False, port=5000, threaded=True)
