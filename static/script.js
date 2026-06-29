(() => {
  "use strict";

  const PROVIDERS = {
    openai:     { label: "OpenAI",          color: "#74AA9C", suggestions: ["gpt-4o", "gpt-4o-mini", "o1-mini"] },
    anthropic:  { label: "Anthropic",       color: "#D97757", suggestions: ["claude-sonnet-4-6", "claude-opus-4-7", "claude-haiku-4-5-20251001"] },
    deepseek:   { label: "DeepSeek",        color: "#4D6BFE", suggestions: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"] },
    gemini:     { label: "Google Gemini",   color: "#4285F4", suggestions: ["gemini-2.0-flash", "gemini-1.5-pro"] },
    groq:       { label: "Groq",            color: "#F55036", suggestions: ["llama-3.3-70b-versatile", "mixtral-8x7b-32768"] },
    nvidia:     { label: "NVIDIA NIM",      color: "#76B900", suggestions: ["deepseek-ai/deepseek-v3.2", "moonshotai/kimi-2.5"] },
    openrouter: { label: "OpenRouter",      color: "#8B5CF6", suggestions: ["deepseek/deepseek-v3.2", "meta-llama/llama-3.3-70b-instruct", "qwen/qwen-2.5-72b-instruct"] },
    mistral:    { label: "Mistral",         color: "#FA520F", suggestions: ["mistral-large-latest", "mistral-small-latest"] },
    xai:        { label: "xAI (Grok)",      color: "#E5E5E5", suggestions: ["grok-4", "grok-4-fast"] },
    together:   { label: "Together AI",     color: "#0F6FFF", suggestions: ["deepseek-ai/DeepSeek-V3.2", "meta-llama/Llama-3.3-70B-Instruct-Turbo"] },
    cerebras:   { label: "Cerebras",        color: "#F15A29", suggestions: ["llama-3.3-70b", "deepseek-r1-distill-llama-70b"] },
  };

  const SK = { keys: "switchboard_keys", lines: "switchboard_lines", turns: "switchboard_turns", sessions: "switchboard_sessions" };

  // ============ State ============
  let keys     = loadJSON(SK.keys,     {});
  let lines    = loadJSON(SK.lines,    []);
  let turns    = loadJSON(SK.turns,    []);
  let sessions = loadJSON(SK.sessions, []);
  let editingLineId = null;
  let sending  = false;
  let abortCtrl = null;        // AbortController for cancel
  let historyVisible = false;

  // Voice state: "idle" | "listening" | "reviewing"
  let recognition = null;
  let voiceState  = "idle";
  let voiceFinal  = "";

  function loadJSON(k, fb) { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : fb; } catch { return fb; } }
  function saveLines()    { localStorage.setItem(SK.lines,    JSON.stringify(lines)); }
  function saveTurns()    { localStorage.setItem(SK.turns,    JSON.stringify(turns.slice(-100))); }
  function saveKeys()     { localStorage.setItem(SK.keys,     JSON.stringify(keys)); }
  function saveSessions() { localStorage.setItem(SK.sessions, JSON.stringify(sessions.slice(-50))); }
  function uid()          { return "id_" + Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

  // ============ Markdown rendering (response bodies) ============
  // Lightweight, dependency-free markdown -> HTML. Escapes raw text FIRST
  // (XSS-safe — model output is untrusted), then layers markdown syntax on
  // top of the already-escaped string. Resilient to incomplete/streaming
  // markdown (e.g. an unclosed "**" while tokens are still arriving).
  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderInline(text) {
    // Inline code first, so its contents are protected from bold/italic parsing.
    const codeTokens = [];
    text = text.replace(/`([^`\n]+)`/g, (_, code) => {
      codeTokens.push(code);
      return `\u0000CODE${codeTokens.length - 1}\u0000`;
    });
    text = text.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/__([^_\n]+?)__/g, "<strong>$1</strong>");
    text = text.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "<em>$1</em>");
    text = text.replace(/(?<!_)_([^_\n]+?)_(?!_)/g, "<em>$1</em>");
    // Links: only allow http(s) targets to avoid javascript: etc.
    text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    text = text.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => `<code>${codeTokens[+i]}</code>`);
    return text;
  }

  function renderMarkdown(raw) {
    if (!raw) return "";
    const lines = escapeHtml(raw).split("\n");

    let html = "";
    let i = 0;
    let listType = null;     // 'ul' | 'ol' | null
    let tableRows = [];
    let inCodeBlock = false;
    let codeBuf = [];
    let codeLang = "";

    const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };
    const flushTable = () => {
      if (!tableRows.length) return;
      const isSep = (row) => row.replace(/[\s|:-]/g, "") === "";
      const rows = tableRows.map(r => r.replace(/^\||\|$/g, "").split("|").map(c => c.trim()));
      let bodyRows = rows, headerRow = null;
      if (rows.length > 1 && isSep(tableRows[1])) { headerRow = rows[0]; bodyRows = rows.slice(2); }
      html += "<table>";
      if (headerRow) html += "<thead><tr>" + headerRow.map(c => `<th>${renderInline(c)}</th>`).join("") + "</tr></thead>";
      html += "<tbody>" + bodyRows.map(r => "<tr>" + r.map(c => `<td>${renderInline(c)}</td>`).join("") + "</tr>").join("") + "</tbody></table>";
      tableRows = [];
    };

    while (i < lines.length) {
      const line = lines[i];

      const fenceMatch = line.match(/^\s*```(\w*)\s*$/);
      if (fenceMatch) {
        if (!inCodeBlock) {
          closeList(); flushTable();
          inCodeBlock = true; codeLang = fenceMatch[1] || ""; codeBuf = [];
        } else {
          html += `<pre class="md-code-block"${codeLang ? ` data-lang="${codeLang}"` : ""}><code>${codeBuf.join("\n")}</code></pre>`;
          inCodeBlock = false;
        }
        i++; continue;
      }
      if (inCodeBlock) { codeBuf.push(line); i++; continue; }

      if (/\|/.test(line) && line.trim().length) { tableRows.push(line); i++; continue; }
      else if (tableRows.length) { flushTable(); }

      const hMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (hMatch) {
        closeList();
        const level = hMatch[1].length;
        html += `<h${level} class="md-h">${renderInline(hMatch[2])}</h${level}>`;
        i++; continue;
      }

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { closeList(); html += "<hr>"; i++; continue; }

      const ulMatch = line.match(/^\s*[-*+]\s+(.*)$/);
      if (ulMatch) {
        if (listType !== "ul") { closeList(); html += "<ul>"; listType = "ul"; }
        html += `<li>${renderInline(ulMatch[1])}</li>`;
        i++; continue;
      }

      const olMatch = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (olMatch) {
        if (listType !== "ol") { closeList(); html += "<ol>"; listType = "ol"; }
        html += `<li>${renderInline(olMatch[1])}</li>`;
        i++; continue;
      }

      closeList();
      if (line.trim() === "") { i++; continue; }
      html += `<p>${renderInline(line)}</p>`;
      i++;
    }
    closeList();
    flushTable();
    if (inCodeBlock) html += `<pre class="md-code-block"><code>${codeBuf.join("\n")}</code></pre>`;
    return html;
  }

  // ============ DOM ============
  const rackList        = document.getElementById("rackList");
  const rackEmpty       = document.getElementById("rackEmpty");
  const activeCountEl   = document.getElementById("activeCount");
  const responsesEl     = document.getElementById("responses");
  const boardEmpty      = document.getElementById("boardEmpty");
  const promptInput     = document.getElementById("promptInput");
  const composerForm    = document.getElementById("composerForm");
  const sendBtn         = document.getElementById("sendBtn");
  const cancelBtn       = document.getElementById("cancelBtn");
  const historyPanel    = document.getElementById("historyPanel");
  const historyList     = document.getElementById("historyList");
  const toastEl         = document.getElementById("toast");
  const pastePreview    = document.getElementById("pastePreview");
  const pastePreviewTxt = document.getElementById("pastePreviewText");
  const pasteCharCount  = document.getElementById("pasteCharCount");
  const voiceOverlay    = document.getElementById("voiceOverlay");
  const voiceStatus     = document.getElementById("voiceStatus");
  const voiceTranscript = document.getElementById("voiceTranscript");
  const voiceConfirmBtn = document.getElementById("voiceConfirm");
  const voiceRetryBtn   = document.getElementById("voiceRetry");
  const voiceBtn        = document.getElementById("voiceBtn");
  const lineModalBackdrop = document.getElementById("lineModalBackdrop");
  const lineProviderSel   = document.getElementById("lineProvider");
  const lineModelInput    = document.getElementById("lineModel");
  const lineLabelInput    = document.getElementById("lineLabel");
  const lineDeleteBtn     = document.getElementById("lineDelete");
  const keysModalBackdrop = document.getElementById("keysModalBackdrop");
  const keysList          = document.getElementById("keysList");

  // ============ Toast ============
  let toastTimer;
  function showToast(msg, type = "ok") {
    clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.className = "toast show " + type;
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2400);
  }

  // ============ Clipboard ============
  async function copyToClipboard(text, label = "text") {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`✓ ${label} copied`); return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      ok ? showToast(`✓ ${label} copied`) : showToast("Copy failed — try Ctrl+C", "error");
      return ok;
    }
  }

  // ============ Paste Preview ============
  const PASTE_LONG_THRESHOLD = 300; // chars

  function showPastePreview(text) {
    const preview = text.length > 120 ? text.slice(0, 120).trimEnd() + "…" : text;
    pastePreviewTxt.textContent = preview;
    pasteCharCount.textContent  = text.length.toLocaleString() + " chars";
    pastePreview.style.display  = "block";
    requestAnimationFrame(() => pastePreview.classList.add("visible"));
  }

  function hidePastePreview() {
    pastePreview.classList.remove("visible");
    setTimeout(() => { pastePreview.style.display = "none"; }, 200);
  }

  promptInput.addEventListener("paste", (e) => {
    const text = (e.clipboardData || window.clipboardData).getData("text");
    if (text && text.length > PASTE_LONG_THRESHOLD) {
      // Let default paste happen first, then show preview
      setTimeout(() => {
        autoGrow();
        showPastePreview(text);
      }, 0);
    }
  });

  // Also handle auto-grow on any input change
  promptInput.addEventListener("input", () => {
    autoGrow();
    if (promptInput.value.length <= PASTE_LONG_THRESHOLD) hidePastePreview();
  });

  document.getElementById("pasteDismiss").addEventListener("click", hidePastePreview);

  // ============ Rack ============
  function renderRack() {
    rackList.innerHTML = "";
    rackEmpty.style.display = lines.length ? "none" : "block";
    lines.forEach((line) => {
      const meta = PROVIDERS[line.provider] || { label: line.provider, color: "#888" };
      const el = document.createElement("div");
      el.className = "line";
      el.style.setProperty("--line-color", meta.color);
      el.dataset.id = line.id;
      el.innerHTML = `
        <div class="line-top">
          <span class="line-id">${esc(line.label || line.model || "unnamed")}</span>
          <span class="led${line.status ? " " + line.status : ""}"></span>
        </div>
        <div class="line-top" style="margin-top:6px;">
          <span class="line-provider">${esc(meta.label)} · ${esc(line.model || "—")}</span>
          <span class="toggle${line.active ? " on" : ""}" title="${line.active ? "Active" : "Inactive"}"></span>
        </div>`;
      el.querySelector(".toggle").addEventListener("click", (e) => {
        e.stopPropagation(); line.active = !line.active; saveLines(); renderRack();
      });
      el.addEventListener("click", () => openLineModal(line.id));
      rackList.appendChild(el);
    });
    const n = lines.filter(l => l.active).length;
    activeCountEl.textContent = `${n} line${n === 1 ? "" : "s"} active`;
  }

  function setLineStatus(lineId, status) {
    const line = lines.find(l => l.id === lineId);
    if (line) { line.status = status; renderRack(); }
  }

  // ============ Line modal ============
  function populateProviderSelect() {
    lineProviderSel.innerHTML = Object.entries(PROVIDERS)
      .map(([k, p]) => `<option value="${k}">${p.label}</option>`).join("");
  }
  function refreshModelSuggestions() {
    const meta = PROVIDERS[lineProviderSel.value];
    document.getElementById("modelSuggestions").innerHTML =
      (meta?.suggestions || []).map(m => `<option value="${m}"></option>`).join("");
  }
  function openLineModal(lineId) {
    editingLineId = lineId || null;
    const line = lineId ? lines.find(l => l.id === lineId) : null;
    document.getElementById("lineModalTitle").textContent = line ? "Edit line" : "Add a line";
    lineDeleteBtn.style.display = line ? "inline-block" : "none";
    lineProviderSel.value = line ? line.provider : Object.keys(PROVIDERS)[0];
    refreshModelSuggestions();
    lineModelInput.value = line ? line.model : "";
    lineLabelInput.value = line ? line.label || "" : "";
    lineModalBackdrop.classList.add("open");
    setTimeout(() => lineModelInput.focus(), 50);
  }
  function closeLineModal() { lineModalBackdrop.classList.remove("open"); editingLineId = null; }
  function saveLineFromModal() {
    const provider = lineProviderSel.value;
    const model = lineModelInput.value.trim();
    const label = lineLabelInput.value.trim();
    if (!model) { lineModelInput.focus(); return; }
    if (editingLineId) {
      const line = lines.find(l => l.id === editingLineId);
      Object.assign(line, { provider, model, label });
    } else {
      lines.push({ id: uid(), provider, model, label, active: true, status: "" });
    }
    saveLines(); renderRack(); closeLineModal();
  }
  function deleteLine() {
    if (!editingLineId) return;
    lines = lines.filter(l => l.id !== editingLineId);
    saveLines(); renderRack(); closeLineModal();
  }

  // ============ Keys modal ============
  function renderKeysModal() {
    keysList.innerHTML = Object.entries(PROVIDERS).map(([k, p]) => `
      <div class="key-row">
        <div class="key-row-label"><span class="key-row-dot" style="background:${p.color}"></span>${esc(p.label)}</div>
        <input type="password" class="field-input key-input" data-provider="${k}"
          placeholder="${esc(p.label)} API key" value="${esc(keys[k] || "")}" autocomplete="off">
      </div>`).join("");
  }
  function saveKeysFromModal() {
    document.querySelectorAll(".key-input").forEach(i => { keys[i.dataset.provider] = i.value.trim(); });
    saveKeys(); keysModalBackdrop.classList.remove("open"); showToast("✓ API keys saved");
  }

  // ============ Board ============
  function renderBoard() {
    boardEmpty.style.display = turns.length ? "none" : "block";
    responsesEl.querySelectorAll(".turn").forEach(n => n.remove());
    turns.forEach(turn => responsesEl.appendChild(buildTurnEl(turn)));
    responsesEl.scrollTop = responsesEl.scrollHeight;
  }

  function buildTurnEl(turn) {
    const el = document.createElement("div");
    el.className = "turn";
    el.dataset.turnId = turn.id;

    const row = document.createElement("div");
    row.className = "turn-prompt-row";

    const promptEl = document.createElement("div");
    promptEl.className = "turn-prompt";
    promptEl.textContent = turn.prompt;

    const actions = document.createElement("div");
    actions.className = "turn-prompt-actions";

    const resendBtn = mkBtn("action-btn resend-btn",
      `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-5"/></svg> Resend`,
      "Resend this prompt");
    resendBtn.addEventListener("click", () => {
      promptInput.value = turn.prompt; autoGrow(); promptInput.focus();
    });

    const copyBtn = mkBtn("action-btn",
      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
      "Copy prompt");
    copyBtn.addEventListener("click", () => copyToClipboard(turn.prompt, "prompt"));

    actions.appendChild(resendBtn);
    actions.appendChild(copyBtn);
    row.appendChild(promptEl);
    row.appendChild(actions);
    el.appendChild(row);

    const grid = document.createElement("div");
    grid.className = "turn-grid";
    grid.id = "grid_" + turn.id;
    Object.entries(turn.cards).forEach(([lid, card]) => grid.appendChild(buildCardEl(lid, card, turn)));
    el.appendChild(grid);
    return el;
  }

  function buildCardEl(lineId, card, turn) {
    const snap = card.lineSnapshot;
    const meta = PROVIDERS[snap.provider] || { color: "#888" };
    const el = document.createElement("div");
    el.className = "card";
    el.id = `card_${turn.id}_${lineId}`;
    el.style.setProperty("--card-color", meta.color);

    const head = document.createElement("div");
    head.className = "card-head";
    const title = document.createElement("span");
    title.className = "card-title";
    title.textContent = snap.label || snap.model;
    const metaEl = document.createElement("span");
    metaEl.className = "card-meta";
    const led = document.createElement("span");
    led.className = "led " + _ledClass(card.status);
    metaEl.appendChild(led);
    if (card.latency != null) {
      const t = document.createElement("span"); t.textContent = `${card.latency}ms`; metaEl.appendChild(t);
    }
    head.appendChild(title); head.appendChild(metaEl); el.appendChild(head);

    const body = document.createElement("div");
    if (card.status === "pending") {
      body.className = "card-body pending";
      body.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span>`;
    } else if (card.status === "streaming") {
      body.className = "card-body streaming md-rendered";
      body.innerHTML = renderMarkdown(card.text || "");
    } else if (card.status === "error") {
      body.className = "card-body error";
      body.textContent = card.error || "Something went wrong.";
      if (card.text) {
        // Partial text streamed in before the error cut it off — keep it visible, rendered.
        const partial = document.createElement("div");
        partial.className = "card-body-partial md-rendered";
        partial.innerHTML = renderMarkdown(card.text);
        body.appendChild(document.createElement("br"));
        body.appendChild(partial);
      }
    } else if (card.status === "cancelled") {
      body.className = "card-body cancelled";
      body.textContent = "Request cancelled.";
    } else {
      body.className = "card-body md-rendered";
      body.innerHTML = renderMarkdown(card.text || "");
    }
    el.appendChild(body);

    if (card.status === "ok" && card.text) el.appendChild(buildCardFoot(card.text, snap));
    return el;
  }

  function _ledClass(status) {
    if (status === "pending" || status === "streaming") return "pending";
    if (status === "ok") return "ok";
    if (status === "error") return "error";
    return "";
  }

  function buildCardFoot(text, snap) {
    const foot = document.createElement("div");
    foot.className = "card-foot";
    const copyBtn = mkBtn("card-action-btn",
      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy`);
    copyBtn.addEventListener("click", () => copyToClipboard(text, snap.label || snap.model));
    const copyMdBtn = mkBtn("card-action-btn",
      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> MD`);
    copyMdBtn.addEventListener("click", () => copyToClipboard(`**${snap.label || snap.model}**\n\n${text}`, "markdown"));
    foot.appendChild(copyBtn); foot.appendChild(copyMdBtn);
    return foot;
  }

  function updateCardInDOM(turnId, lineId, card) {
    const el = document.getElementById(`card_${turnId}_${lineId}`);
    if (!el) return;
    const led = el.querySelector(".led");
    if (led) led.className = `led ${_ledClass(card.status)}`;
    const metaEl = el.querySelector(".card-meta");
    if (metaEl && card.latency != null) {
      let t = metaEl.querySelector("span:not(.led)");
      if (!t) { t = document.createElement("span"); metaEl.appendChild(t); }
      t.textContent = `${card.latency}ms`;
    }
    const body = el.querySelector(".card-body");
    if (body) {
      if (card.status === "streaming") {
        body.className = "card-body streaming md-rendered";
        body.innerHTML = renderMarkdown(card.text || "");
      } else if (card.status === "error") {
        body.className = "card-body error";
        body.textContent = card.error || "Error.";
        if (card.text) {
          body.appendChild(document.createElement("br"));
          const partial = document.createElement("div");
          partial.className = "card-body-partial md-rendered";
          partial.innerHTML = renderMarkdown(card.text);
          body.appendChild(partial);
        }
      } else if (card.status === "cancelled") {
        body.className = "card-body cancelled"; body.textContent = "Request cancelled.";
      } else if (card.status === "ok") {
        body.className = "card-body md-rendered"; body.innerHTML = renderMarkdown(card.text || "");
        if (!el.querySelector(".card-foot")) el.appendChild(buildCardFoot(card.text, card.lineSnapshot));
      }
    }
  }

  // ============ History panel ============
  function toggleHistory() {
    historyVisible = !historyVisible;
    historyPanel.classList.toggle("open", historyVisible);
    document.getElementById("historyToggleBtn").classList.toggle("active", historyVisible);
    if (historyVisible) renderHistoryPanel();
  }

  function renderHistoryPanel() {
    if (!sessions.length) { historyList.innerHTML = `<p class="history-empty muted">No conversations yet.</p>`; return; }
    historyList.innerHTML = "";
    [...sessions].reverse().forEach(session => {
      const item = document.createElement("div");
      item.className = "history-item";
      const date = new Date(session.date);
      item.innerHTML = `
        <div class="history-item-title">${esc(session.title || "Untitled")}</div>
        <div class="history-item-meta">${formatDate(date)} · ${session.turns.length} turn${session.turns.length !== 1 ? "s" : ""}</div>
        <div class="history-item-actions"></div>`;
      const actions = item.querySelector(".history-item-actions");
      const loadBtn = mkBtn("btn btn-ghost btn-xs", "Load");
      loadBtn.addEventListener("click", () => loadSession(session));
      const delBtn = mkBtn("btn btn-ghost btn-xs btn-danger", "✕");
      delBtn.addEventListener("click", (e) => { e.stopPropagation(); sessions = sessions.filter(s => s.id !== session.id); saveSessions(); renderHistoryPanel(); });
      actions.appendChild(loadBtn); actions.appendChild(delBtn);
      historyList.appendChild(item);
    });
  }

  function saveCurrentSession() {
    if (!turns.length) return;
    const title = turns[0].prompt.slice(0, 48) + (turns[0].prompt.length > 48 ? "…" : "");
    const existing = sessions.find(s => s.turns.length && s.turns[0].id === turns[0].id);
    if (existing) { existing.turns = [...turns]; existing.date = Date.now(); }
    else sessions.push({ id: uid(), title, date: Date.now(), turns: [...turns] });
    saveSessions();
    if (historyVisible) renderHistoryPanel();
  }

  function loadSession(session) {
    if (turns.length) saveCurrentSession();
    turns = [...session.turns];
    saveTurns(); renderBoard();
    if (historyVisible) toggleHistory();
    showToast("✓ Session loaded");
  }

  function startNewChat() {
    if (turns.length) saveCurrentSession();
    turns = [];
    saveTurns();
    renderBoard();
    lines.forEach(l => { l.status = ""; });
    renderRack();
    if (historyVisible) renderHistoryPanel();
    promptInput.value = "";
    autoGrow();
    promptInput.focus();
    showToast("✓ New chat started");
  }

  function clearHistory() {
    if (!confirm("Clear all saved history?")) return;
    sessions = []; saveSessions(); renderHistoryPanel(); showToast("History cleared");
  }

  function formatDate(date) {
    const diff = Date.now() - date;
    if (diff < 60000) return "just now";
    if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
    return date.toLocaleDateString(undefined, { month:"short", day:"numeric" });
  }

  // ============ Cancel request ============
  function cancelRequest() {
    if (!sending || !abortCtrl) return;
    abortCtrl.abort();
    showToast("Request cancelled", "warn");
  }

  // ============ Sending (SSE streaming + AbortController) ============
  function historyForLine(lineId) {
    const msgs = [];
    for (const t of turns) {
      const card = t.cards[lineId];
      if (card && card.status === "ok") {
        msgs.push({ role: "user", content: t.prompt });
        msgs.push({ role: "assistant", content: card.text });
      }
    }
    return msgs;
  }

  async function sendPrompt(promptText) {
    const activeLines = lines.filter(l => l.active);
    if (!activeLines.length || sending) return;

    sending = true;
    abortCtrl = new AbortController();
    sendBtn.disabled = true;
    sendBtn.textContent = "Sending…";
    cancelBtn.style.display = "inline-flex";
    hidePastePreview();

    const turn = { id: "t_" + Date.now(), prompt: promptText, cards: {} };
    activeLines.forEach(line => {
      turn.cards[line.id] = { status: "pending", lineSnapshot: { provider: line.provider, model: line.model, label: line.label } };
      setLineStatus(line.id, "pending");
    });
    turns.push(turn);
    boardEmpty.style.display = "none";
    responsesEl.appendChild(buildTurnEl(turn));
    responsesEl.scrollTop = responsesEl.scrollHeight;

    const payload = {
      prompt: promptText,
      lines: activeLines.map(line => ({
        id: line.id, provider: line.provider, model: line.model,
        api_key: keys[line.provider] || "", history: historyForLine(line.id),
      })),
    };

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: abortCtrl.signal,
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        activeLines.forEach(line => {
          turn.cards[line.id] = { ...turn.cards[line.id], status: "error", error: data.error || "Request failed" };
          setLineStatus(line.id, "error");
          updateCardInDOM(turn.id, line.id, turn.cards[line.id]);
        });
      } else {
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let lastScroll = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop();
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            try {
              const r = JSON.parse(line.slice(5).trim());
              const prev = turn.cards[r.id] || {};
              if (r.type === "delta") {
                // Token(s) just arrived — append and mark as streaming so the
                // card renders the growing text immediately.
                turn.cards[r.id] = { ...prev, status: "streaming", text: (prev.text || "") + r.text };
              } else if (r.type === "done") {
                turn.cards[r.id] = {
                  ...prev,
                  status:  r.ok ? "ok" : "error",
                  text:    prev.text,           // keep whatever streamed in, even on error
                  error:   r.error,
                  latency: r.latency_ms,
                };
                setLineStatus(r.id, r.ok ? "ok" : "error");
              } else {
                // Back-compat: a non-streaming single-shot result, if it ever shows up.
                turn.cards[r.id] = { ...prev, status: r.ok ? "ok" : "error", text: r.text, error: r.error, latency: r.latency_ms };
                setLineStatus(r.id, r.ok ? "ok" : "error");
              }
              updateCardInDOM(turn.id, r.id, turn.cards[r.id]);
              // Throttle auto-scroll to ~20/sec so a fast stream doesn't
              // jank-scroll on every single token.
              const now = performance.now();
              if (now - lastScroll > 50) {
                responsesEl.scrollTop = responsesEl.scrollHeight;
                lastScroll = now;
              }
            } catch {}
          }
        }
        responsesEl.scrollTop = responsesEl.scrollHeight;
      }
    } catch (err) {
      const wasCancelled = err.name === "AbortError";
      activeLines.forEach(line => {
        // Catch lines that never started (pending) or were cut off mid-stream.
        const status = turn.cards[line.id].status;
        if (status === "pending" || status === "streaming") {
          turn.cards[line.id] = {
            ...turn.cards[line.id],
            status: wasCancelled ? "cancelled" : "error",
            error: wasCancelled ? null : "Network error — is the Flask server running?",
          };
          setLineStatus(line.id, wasCancelled ? "" : "error");
          updateCardInDOM(turn.id, line.id, turn.cards[line.id]);
        }
      });
    }

    saveTurns();
    saveCurrentSession();
    sending = false;
    abortCtrl = null;
    sendBtn.disabled = false;
    sendBtn.textContent = "Send";
    cancelBtn.style.display = "none";
  }

  // ============ Voice to text ============
  function initVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      voiceBtn.title = "Voice not supported in this browser";
      voiceBtn.style.opacity = "0.35";
      voiceBtn.disabled = true;
      return;
    }

    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";

    recognition.onstart = () => {
      voiceState = "listening";
      voiceFinal = "";
      voiceOverlay.classList.add("open");
      voiceStatus.textContent = "Listening…";
      voiceTranscript.textContent = "";
      voiceConfirmBtn.style.display = "none";
      voiceRetryBtn.style.display = "none";
      voiceBtn.classList.add("recording");
    };

    recognition.onresult = (e) => {
      let interim = "";
      voiceFinal = "";
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) voiceFinal += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      voiceTranscript.textContent = voiceFinal + interim;
      if (voiceFinal.trim()) {
        voiceStatus.textContent = "Got it! Review below.";
        voiceConfirmBtn.style.display = "inline-block";
      }
    };

    recognition.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        showToast("Microphone access denied — check your browser's site permissions", "error");
        closeVoiceOverlay();
      } else if (e.error === "no-speech") {
        // let onend handle the "nothing detected" messaging; don't close the overlay
      } else if (e.error !== "aborted") {
        showToast("Voice error: " + e.error, "error");
        closeVoiceOverlay();
      }
    };

    recognition.onend = () => {
      voiceBtn.classList.remove("recording");
      if (voiceState !== "listening") return; // already handled (confirmed/cancelled/error-closed)
      voiceState = "reviewing";
      voiceRetryBtn.style.display = "inline-block";
      if (voiceFinal.trim()) {
        voiceStatus.textContent = "Done — confirm or try again.";
        voiceConfirmBtn.style.display = "inline-block";
      } else {
        voiceStatus.textContent = "Nothing detected. Try again or cancel.";
        voiceConfirmBtn.style.display = "none";
      }
    };
  }

  function startVoice() {
    if (!recognition) return;
    voiceFinal = "";
    voiceTranscript.textContent = "";
    try { recognition.start(); }
    catch {
      // start() throws if already running — stop then restart on the next tick
      try { recognition.stop(); } catch {}
      setTimeout(() => { try { recognition.start(); } catch {} }, 50);
    }
  }

  function closeVoiceOverlay() {
    voiceState = "idle";
    voiceBtn.classList.remove("recording");
    voiceOverlay.classList.remove("open");
    voiceFinal = "";
  }

  function stopVoice(confirm = false) {
    const finalText = voiceFinal.trim();
    voiceState = "idle";
    try { recognition && recognition.stop(); } catch {}
    voiceBtn.classList.remove("recording");
    if (confirm && finalText) {
      const existing = promptInput.value;
      promptInput.value = existing ? existing + " " + finalText : finalText;
      autoGrow();
      promptInput.focus();
      showToast("✓ Voice added to input");
    }
    voiceOverlay.classList.remove("open");
    voiceFinal = "";
  }

  voiceBtn.addEventListener("click", () => {
    if (!recognition) return;
    if (voiceState === "listening") {
      // user wants to stop early and review what's been captured so far
      recognition.stop();
    } else {
      startVoice();
    }
  });

  document.getElementById("voiceCancel").addEventListener("click", () => closeVoiceOverlay());
  voiceConfirmBtn.addEventListener("click", () => stopVoice(true));
  document.getElementById("voiceRetry").addEventListener("click", () => startVoice());

  // ============ Utilities ============
  function esc(str) {
    return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function mkBtn(cls, html, title) {
    const b = document.createElement("button");
    b.className = cls; b.type = "button";
    if (html) b.innerHTML = html;
    if (title) b.title = title;
    return b;
  }
  function autoGrow() {
    promptInput.style.height = "auto";
    promptInput.style.height = Math.min(promptInput.scrollHeight, 260) + "px";
  }

  // ============ Wire events ============
  populateProviderSelect();
  lineProviderSel.addEventListener("change", refreshModelSuggestions);

  document.getElementById("addLineBtn").addEventListener("click", () => openLineModal(null));
  document.getElementById("rackEmptyAdd").addEventListener("click", () => openLineModal(null));
  document.getElementById("lineModalClose").addEventListener("click", closeLineModal);
  document.getElementById("lineCancel").addEventListener("click", closeLineModal);
  document.getElementById("lineSave").addEventListener("click", saveLineFromModal);
  lineDeleteBtn.addEventListener("click", deleteLine);
  lineModalBackdrop.addEventListener("click", e => { if (e.target === lineModalBackdrop) closeLineModal(); });

  document.getElementById("keysBtn").addEventListener("click", () => { renderKeysModal(); keysModalBackdrop.classList.add("open"); });
  document.getElementById("keysModalClose").addEventListener("click", () => keysModalBackdrop.classList.remove("open"));
  document.getElementById("keysSave").addEventListener("click", saveKeysFromModal);
  keysModalBackdrop.addEventListener("click", e => { if (e.target === keysModalBackdrop) keysModalBackdrop.classList.remove("open"); });

  document.getElementById("newChatBtn").addEventListener("click", startNewChat);
  document.getElementById("historyToggleBtn").addEventListener("click", toggleHistory);
  document.getElementById("clearHistoryBtn").addEventListener("click", clearHistory);

  cancelBtn.addEventListener("click", cancelRequest);

  promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); composerForm.requestSubmit(); }
  });

  composerForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = promptInput.value.trim();
    if (!text) return;
    promptInput.value = ""; autoGrow();
    sendPrompt(text);
  });

  // ============ Boot ============
  lines.forEach(l => { if (l.status === undefined) l.status = ""; });
  initVoice();
  renderRack();
  renderBoard();
})();
