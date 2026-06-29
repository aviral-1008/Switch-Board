"""
providers.py
Thin, uniform wrappers around different chat-completion APIs.

Two calling styles are provided per provider:
  - call_*()   blocking, returns the full reply text (kept for compatibility).
  - stream_*() generator, yields text chunks as they arrive over the wire.

Streaming is what makes responses *feel* fast: the browser can start
rendering a reply the moment the first token comes back instead of waiting
for the whole completion. A pooled requests.Session is reused across calls
to avoid repeating the TCP/TLS handshake on every request, which shaves
real (not just perceived) latency, especially when several lines hit the
same provider back-to-back.
"""

import json
import requests

DEFAULT_TIMEOUT = 90
DEFAULT_MAX_TOKENS = 1536
DEFAULT_CONNECT_TIMEOUT = 6  # fail fast on dead/unreachable hosts

# ── Connection pooling ───────────────────────────────────────────────────────
# One Session per worker process, reused for every outgoing call. This keeps
# TCP + TLS handshakes warm (HTTP keep-alive) instead of paying that cost on
# every single request, and lets us raise the pool size so concurrent lines
# hitting the same provider don't queue behind each other.
_session = requests.Session()
_adapter = requests.adapters.HTTPAdapter(
    pool_connections=20,
    pool_maxsize=20,
    max_retries=0,
)
_session.mount("https://", _adapter)
_session.mount("http://", _adapter)


def _timeout_tuple(timeout):
    """(connect_timeout, read_timeout) — fail fast on connect, patient on read."""
    return (DEFAULT_CONNECT_TIMEOUT, timeout)


def _extract_error(resp):
    try:
        data = resp.json()
        msg = (
            data.get("error", {}).get("message")
            if isinstance(data.get("error"), dict)
            else data.get("error")
        ) or data.get("message") or resp.text
        return f"HTTP {resp.status_code}: {msg}"
    except Exception:
        return f"HTTP {resp.status_code}: {resp.text[:300]}"


def _extract_error_bytes(resp):
    try:
        raw = resp.content
        data = json.loads(raw)
        msg = (
            data.get("error", {}).get("message")
            if isinstance(data.get("error"), dict)
            else data.get("error")
        ) or data.get("message") or raw[:300].decode("utf-8", "replace")
        return f"HTTP {resp.status_code}: {msg}"
    except Exception:
        return f"HTTP {resp.status_code}: {resp.text[:300]}"


# ── OpenAI-compatible family (OpenAI, NVIDIA, Groq, DeepSeek, OpenRouter, ─────
#    Mistral, xAI, Together, Cerebras — they all speak the same dialect) ─────
def _openai_style(base_url, api_key, model, messages, extra_headers=None, timeout=DEFAULT_TIMEOUT):
    """Blocking call. Returns the full reply text."""
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    if extra_headers:
        headers.update(extra_headers)
    payload = {"model": model, "messages": messages, "max_tokens": DEFAULT_MAX_TOKENS}
    resp = _session.post(
        f"{base_url}/chat/completions", headers=headers, json=payload, timeout=_timeout_tuple(timeout)
    )
    if not resp.ok:
        raise RuntimeError(_extract_error(resp))
    data = resp.json()
    return data["choices"][0]["message"]["content"]


def _openai_style_stream(base_url, api_key, model, messages, extra_headers=None, timeout=DEFAULT_TIMEOUT):
    """Generator. Yields text chunks as they stream in (SSE, OpenAI wire format)."""
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    if extra_headers:
        headers.update(extra_headers)
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": DEFAULT_MAX_TOKENS,
        "stream": True,
    }
    with _session.post(
        f"{base_url}/chat/completions",
        headers=headers,
        json=payload,
        timeout=_timeout_tuple(timeout),
        stream=True,
    ) as resp:
        if not resp.ok:
            raise RuntimeError(_extract_error_bytes(resp))
        for raw_line in resp.iter_lines(decode_unicode=True):
            if not raw_line or not raw_line.startswith("data:"):
                continue
            chunk = raw_line[5:].strip()
            if chunk == "[DONE]":
                break
            try:
                obj = json.loads(chunk)
            except ValueError:
                continue
            choices = obj.get("choices") or []
            if not choices:
                continue
            delta = choices[0].get("delta") or {}
            text = delta.get("content")
            if text:
                yield text


def call_openai(api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    return _openai_style("https://api.openai.com/v1", api_key, model, messages, timeout=timeout)


def stream_openai(api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    yield from _openai_style_stream("https://api.openai.com/v1", api_key, model, messages, timeout=timeout)


def call_nvidia(api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    # NVIDIA NIM is OpenAI-compatible
    return _openai_style("https://integrate.api.nvidia.com/v1", api_key, model, messages, timeout=timeout)


def stream_nvidia(api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    yield from _openai_style_stream("https://integrate.api.nvidia.com/v1", api_key, model, messages, timeout=timeout)


def call_groq(api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    return _openai_style("https://api.groq.com/openai/v1", api_key, model, messages, timeout=timeout)


def stream_groq(api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    yield from _openai_style_stream("https://api.groq.com/openai/v1", api_key, model, messages, timeout=timeout)


def call_deepseek(api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    # DeepSeek's official API is OpenAI-compatible.
    return _openai_style("https://api.deepseek.com", api_key, model, messages, timeout=timeout)


def stream_deepseek(api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    yield from _openai_style_stream("https://api.deepseek.com", api_key, model, messages, timeout=timeout)


def call_openrouter(api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    # OpenRouter is OpenAI-compatible and proxies most open models (DeepSeek,
    # Llama, Qwen, Mistral, etc.) plus OpenAI/Anthropic/Gemini under one key.
    return _openai_style(
        "https://openrouter.ai/api/v1",
        api_key,
        model,
        messages,
        extra_headers={"HTTP-Referer": "https://switchboard.local", "X-Title": "Switchboard"},
        timeout=timeout,
    )


def stream_openrouter(api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    yield from _openai_style_stream(
        "https://openrouter.ai/api/v1",
        api_key,
        model,
        messages,
        extra_headers={"HTTP-Referer": "https://switchboard.local", "X-Title": "Switchboard"},
        timeout=timeout,
    )


def call_mistral(api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    return _openai_style("https://api.mistral.ai/v1", api_key, model, messages, timeout=timeout)


def stream_mistral(api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    yield from _openai_style_stream("https://api.mistral.ai/v1", api_key, model, messages, timeout=timeout)


def call_xai(api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    # xAI's Grok API is OpenAI-compatible.
    return _openai_style("https://api.x.ai/v1", api_key, model, messages, timeout=timeout)


def stream_xai(api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    yield from _openai_style_stream("https://api.x.ai/v1", api_key, model, messages, timeout=timeout)


def call_together(api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    return _openai_style("https://api.together.xyz/v1", api_key, model, messages, timeout=timeout)


def stream_together(api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    yield from _openai_style_stream("https://api.together.xyz/v1", api_key, model, messages, timeout=timeout)


def call_cerebras(api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    return _openai_style("https://api.cerebras.ai/v1", api_key, model, messages, timeout=timeout)


def stream_cerebras(api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    yield from _openai_style_stream("https://api.cerebras.ai/v1", api_key, model, messages, timeout=timeout)


# ── Anthropic ─────────────────────────────────────────────────────────────────
def _anthropic_payload(model, messages):
    system = None
    convo = []
    for m in messages:
        if m["role"] == "system":
            system = m["content"]
        else:
            convo.append({"role": m["role"], "content": m["content"]})
    payload = {"model": model, "max_tokens": DEFAULT_MAX_TOKENS, "messages": convo}
    if system:
        payload["system"] = system
    return payload


def call_anthropic(api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    resp = _session.post(
        "https://api.anthropic.com/v1/messages",
        headers=headers,
        json=_anthropic_payload(model, messages),
        timeout=_timeout_tuple(timeout),
    )
    if not resp.ok:
        raise RuntimeError(_extract_error(resp))
    data = resp.json()
    return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")


def stream_anthropic(api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    payload = _anthropic_payload(model, messages)
    payload["stream"] = True
    with _session.post(
        "https://api.anthropic.com/v1/messages",
        headers=headers,
        json=payload,
        timeout=_timeout_tuple(timeout),
        stream=True,
    ) as resp:
        if not resp.ok:
            raise RuntimeError(_extract_error_bytes(resp))
        event_type = None
        for raw_line in resp.iter_lines(decode_unicode=True):
            if raw_line is None:
                continue
            if raw_line.startswith("event:"):
                event_type = raw_line[6:].strip()
                continue
            if not raw_line.startswith("data:"):
                continue
            chunk = raw_line[5:].strip()
            if not chunk:
                continue
            try:
                obj = json.loads(chunk)
            except ValueError:
                continue
            if event_type == "content_block_delta":
                delta = obj.get("delta") or {}
                if delta.get("type") == "text_delta":
                    text = delta.get("text")
                    if text:
                        yield text
            elif event_type == "error":
                msg = (obj.get("error") or {}).get("message", "Anthropic stream error")
                raise RuntimeError(msg)


# ── Google Gemini ─────────────────────────────────────────────────────────────
def _gemini_request_parts(messages):
    system_instruction = None
    contents = []
    for m in messages:
        if m["role"] == "system":
            system_instruction = m["content"]
            continue
        role = "model" if m["role"] == "assistant" else "user"
        contents.append({"role": role, "parts": [{"text": m["content"]}]})
    return system_instruction, contents


def call_gemini(api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    system_instruction, contents = _gemini_request_parts(messages)
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    payload = {"contents": contents}
    if system_instruction:
        payload["systemInstruction"] = {"parts": [{"text": system_instruction}]}

    resp = _session.post(url, params={"key": api_key}, json=payload, timeout=_timeout_tuple(timeout))
    if not resp.ok:
        raise RuntimeError(_extract_error(resp))
    data = resp.json()
    candidates = data.get("candidates") or []
    if not candidates:
        reason = data.get("promptFeedback", {}).get("blockReason", "no candidates returned")
        raise RuntimeError(f"Gemini returned no output ({reason})")
    parts = candidates[0].get("content", {}).get("parts", [])
    return "".join(p.get("text", "") for p in parts)


def stream_gemini(api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    system_instruction, contents = _gemini_request_parts(messages)
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent"
    payload = {"contents": contents}
    if system_instruction:
        payload["systemInstruction"] = {"parts": [{"text": system_instruction}]}

    with _session.post(
        url,
        params={"key": api_key, "alt": "sse"},
        json=payload,
        timeout=_timeout_tuple(timeout),
        stream=True,
    ) as resp:
        if not resp.ok:
            raise RuntimeError(_extract_error_bytes(resp))
        got_any = False
        for raw_line in resp.iter_lines(decode_unicode=True):
            if not raw_line or not raw_line.startswith("data:"):
                continue
            chunk = raw_line[5:].strip()
            if not chunk:
                continue
            try:
                obj = json.loads(chunk)
            except ValueError:
                continue
            candidates = obj.get("candidates") or []
            if not candidates:
                reason = obj.get("promptFeedback", {}).get("blockReason")
                if reason:
                    raise RuntimeError(f"Gemini returned no output ({reason})")
                continue
            parts = candidates[0].get("content", {}).get("parts", [])
            text = "".join(p.get("text", "") for p in parts)
            if text:
                got_any = True
                yield text
        if not got_any:
            # Some failures surface as an empty stream with no error frame.
            pass


# ── Dispatch tables ────────────────────────────────────────────────────────────
PROVIDER_FUNCS = {
    "openai": call_openai,
    "anthropic": call_anthropic,
    "nvidia": call_nvidia,
    "gemini": call_gemini,
    "groq": call_groq,
    "deepseek": call_deepseek,
    "openrouter": call_openrouter,
    "mistral": call_mistral,
    "xai": call_xai,
    "together": call_together,
    "cerebras": call_cerebras,
}

PROVIDER_STREAM_FUNCS = {
    "openai": stream_openai,
    "anthropic": stream_anthropic,
    "nvidia": stream_nvidia,
    "gemini": stream_gemini,
    "groq": stream_groq,
    "deepseek": stream_deepseek,
    "openrouter": stream_openrouter,
    "mistral": stream_mistral,
    "xai": stream_xai,
    "together": stream_together,
    "cerebras": stream_cerebras,
}


def _check_args(provider, api_key, model, table):
    if provider not in table:
        raise ValueError(f"Unknown provider '{provider}'")
    if not api_key:
        raise ValueError("No API key set for this provider")
    if not model:
        raise ValueError("No model name set for this line")


def call_model(provider, api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    """Blocking call. Returns the full reply text. Kept for compatibility."""
    _check_args(provider, api_key, model, PROVIDER_FUNCS)
    return PROVIDER_FUNCS[provider](api_key, model, messages, timeout=timeout)


def stream_model(provider, api_key, model, messages, timeout=DEFAULT_TIMEOUT):
    """Generator. Yields text chunks as they arrive from the provider."""
    _check_args(provider, api_key, model, PROVIDER_STREAM_FUNCS)
    yield from PROVIDER_STREAM_FUNCS[provider](api_key, model, messages, timeout=timeout)
