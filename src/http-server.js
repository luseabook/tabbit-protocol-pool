import http from "node:http";

const DEFAULT_API_KEY = "sk-tabbit-local";

class InvalidJsonError extends Error {
  constructor(message = "Request body must be valid JSON.") {
    super(message);
    this.name = "InvalidJsonError";
    this.code = "INVALID_JSON";
  }
}

export function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function writeHtml(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function adminDashboardHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tabbit Pool Admin</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #ffffff;
      --panel: #ffffff;
      --text: #050505;
      --muted: #626262;
      --line: #050505;
      --line-soft: #d7d7d7;
      --accent: #00d7ff;
      --acid: #eaff00;
      --hot: #ff5a3c;
      --ok: #008a45;
      --warn: #b25b00;
      --bad: #c1121f;
      --shadow: 8px 8px 0 #050505;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
      letter-spacing: 0;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 24px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.2;
      font-weight: 700;
    }
    main {
      width: min(1180px, calc(100% - 32px));
      margin: 20px auto;
      display: grid;
      gap: 16px;
    }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) auto;
      gap: 10px;
      width: min(560px, 100%);
    }
    input {
      min-width: 0;
      height: 38px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 10px;
      font: inherit;
      background: #fff;
    }
    button {
      height: 38px;
      border: 0;
      border-radius: 6px;
      padding: 0 14px;
      font: inherit;
      font-weight: 650;
      background: var(--accent);
      color: #fff;
      cursor: pointer;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
    }
    h2 {
      margin: 0 0 12px;
      font-size: 14px;
      line-height: 1.3;
    }
    dl {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 10px;
      margin: 0;
    }
    dt {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 3px;
    }
    dd {
      margin: 0;
      font-size: 15px;
      overflow-wrap: anywhere;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 16px;
    }
    .status-ok { color: var(--accent); }
    .status-blocked, .status-degraded { color: var(--warn); }
    .status-error { color: var(--bad); }
    pre {
      margin: 0;
      max-height: 360px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.5;
      background: #101828;
      color: #e4e7ec;
      border-radius: 6px;
      padding: 12px;
    }
    @media (max-width: 680px) {
      header { align-items: stretch; flex-direction: column; padding: 16px; }
      .toolbar { grid-template-columns: 1fr; }
      main { width: calc(100% - 20px); margin: 10px auto; }
    }
    html { min-height: 100%; }
    body {
      min-height: 100vh;
      overflow-x: hidden;
    }
    .motion-grid {
      position: fixed;
      inset: 0;
      z-index: -1;
      background:
        linear-gradient(90deg, rgba(5, 5, 5, 0.06) 1px, transparent 1px),
        linear-gradient(0deg, rgba(5, 5, 5, 0.06) 1px, transparent 1px),
        repeating-linear-gradient(135deg, transparent 0 28px, rgba(0, 215, 255, 0.16) 28px 30px, transparent 30px 58px);
      background-size: 44px 44px, 44px 44px, 120px 120px;
      animation: grid-drift 18s linear infinite;
    }
    .motion-grid::after {
      content: "";
      position: absolute;
      inset: 0;
      background: repeating-linear-gradient(90deg, transparent 0 84px, rgba(234, 255, 0, 0.28) 84px 88px, transparent 88px 178px);
      clip-path: polygon(58% 0, 100% 0, 100% 100%, 72% 100%);
      animation: slice-drift 9s ease-in-out infinite alternate;
    }
    .admin-shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 252px minmax(0, 1fr);
      gap: 22px;
      padding: 18px;
    }
    .ops-rail {
      position: sticky;
      top: 18px;
      align-self: start;
      min-height: calc(100vh - 36px);
      border: 2px solid var(--line);
      background: var(--panel);
      box-shadow: var(--shadow);
      padding: 18px;
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 22px;
      transform: skewY(-1deg);
    }
    .ops-rail > * { transform: skewY(1deg); }
    .brand-lockup {
      display: grid;
      grid-template-columns: 48px 1fr;
      gap: 12px;
      align-items: center;
    }
    .brand-mark {
      width: 48px;
      height: 48px;
      display: grid;
      place-items: center;
      border: 2px solid var(--line);
      background: var(--acid);
      font-weight: 900;
      box-shadow: 4px 4px 0 var(--line);
    }
    .eyebrow {
      margin: 0 0 3px;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      font-weight: 800;
    }
    .rail-nav {
      display: grid;
      gap: 8px;
      align-content: start;
    }
    .rail-nav a {
      color: var(--text);
      text-decoration: none;
      border: 2px solid var(--line);
      background: #fff;
      padding: 10px 12px;
      font-weight: 800;
      box-shadow: 3px 3px 0 var(--line);
    }
    .rail-nav a:nth-child(2) { transform: translateX(10px); }
    .rail-nav a:nth-child(3) { transform: translateX(-4px); }
    .rail-nav a.active {
      background: var(--text);
      color: #fff;
    }
    .rail-status {
      border: 2px solid var(--line);
      padding: 12px;
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 850;
      background: var(--accent);
    }
    .pulse-dot {
      width: 12px;
      height: 12px;
      border: 2px solid var(--line);
      background: var(--acid);
      animation: pulse-dot 1.8s steps(2, end) infinite;
    }
    .console-stage {
      width: auto;
      margin: 0;
      min-width: 0;
      display: grid;
      gap: 18px;
    }
    .topbar {
      min-height: 136px;
      border: 2px solid var(--line);
      background: var(--panel);
      box-shadow: var(--shadow);
      padding: 20px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(320px, 470px);
      gap: 20px;
      align-items: end;
      justify-content: stretch;
      position: relative;
      overflow: hidden;
    }
    .topbar::before {
      content: "";
      position: absolute;
      inset: auto -40px 18px 48%;
      height: 18px;
      border-top: 2px solid var(--line);
      border-bottom: 2px solid var(--line);
      background: var(--acid);
      transform: rotate(-3deg);
      animation: scan-line 4s ease-in-out infinite alternate;
    }
    .title-block {
      position: relative;
      z-index: 1;
      display: grid;
      gap: 10px;
    }
    .kicker-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .kicker-row span {
      border: 2px solid var(--line);
      padding: 4px 8px;
      background: #fff;
    }
    .topbar h2 {
      margin: 0;
      font-size: clamp(32px, 5vw, 64px);
      line-height: 0.92;
      font-weight: 950;
      max-width: 760px;
    }
    .subline {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.5;
    }
    .auth-panel {
      position: relative;
      z-index: 1;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      border: 2px solid var(--line);
      background: #fff;
      padding: 10px;
      box-shadow: 5px 5px 0 var(--line);
    }
    .auth-panel input {
      height: 44px;
      border: 2px solid var(--line);
      border-radius: 0;
      font-weight: 700;
      color: var(--text);
    }
    .auth-panel button {
      height: 44px;
      border: 2px solid var(--line);
      border-radius: 0;
      background: var(--text);
      color: #fff;
      font-weight: 900;
      box-shadow: 3px 3px 0 var(--acid);
      white-space: nowrap;
    }
    .incident-strip {
      border: 2px solid var(--line);
      background: var(--text);
      color: #fff;
      min-height: 64px;
      display: grid;
      grid-template-columns: 160px minmax(0, 1fr) auto;
      gap: 14px;
      align-items: center;
      padding: 14px 18px;
      box-shadow: 6px 6px 0 var(--accent);
    }
    .incident-strip span {
      color: #d8d8d8;
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .incident-strip strong {
      font-size: clamp(20px, 3vw, 34px);
      line-height: 1;
      overflow-wrap: anywhere;
    }
    .metric-wall {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
      border: 0;
      background: transparent;
      padding: 0;
    }
    .metric {
      background: var(--panel);
      border: 2px solid var(--line);
      padding: 16px;
      min-height: 124px;
      display: grid;
      align-content: space-between;
      box-shadow: 5px 5px 0 var(--line);
      position: relative;
      overflow: hidden;
    }
    .metric:nth-child(2) { transform: translateY(14px); }
    .metric:nth-child(3) { transform: translateY(-6px); }
    .metric:nth-child(4) { transform: translateY(8px); }
    .metric::after {
      content: "";
      position: absolute;
      right: -20px;
      bottom: 12px;
      width: 96px;
      height: 12px;
      border: 2px solid var(--line);
      background: var(--accent);
      transform: rotate(-12deg);
    }
    .metric.tone-ok::after { background: var(--acid); }
    .metric.tone-blocked::after,
    .metric.tone-degraded::after { background: var(--hot); }
    .metric-label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .metric-value {
      margin: 0;
      font-size: clamp(22px, 3vw, 36px);
      line-height: 1;
      font-weight: 950;
      overflow-wrap: anywhere;
      position: relative;
      z-index: 1;
    }
    .control-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.95fr);
      gap: 18px;
      align-items: start;
    }
    .ops-panel {
      border: 2px solid var(--line);
      background: var(--panel);
      padding: 16px;
      box-shadow: 6px 6px 0 var(--line);
    }
    .ops-panel:nth-child(2) {
      transform: translateY(18px);
      box-shadow: 6px 6px 0 var(--accent);
    }
    .ops-panel.wide {
      grid-column: 1 / -1;
      transform: translateX(12px);
      width: calc(100% - 12px);
      box-shadow: 6px 6px 0 var(--acid);
    }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border-bottom: 2px solid var(--line);
      padding-bottom: 10px;
      margin-bottom: 12px;
    }
    .panel-head h2 {
      margin: 0;
      font-size: 16px;
      line-height: 1.2;
      font-weight: 950;
    }
    .panel-tag {
      border: 2px solid var(--line);
      background: var(--acid);
      color: var(--text);
      padding: 3px 7px;
      font-size: 11px;
      font-weight: 900;
      white-space: nowrap;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .detail-item {
      border: 2px solid var(--line-soft);
      padding: 10px;
      min-height: 70px;
      background: #fff;
    }
    .detail-label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 850;
      text-transform: uppercase;
    }
    .detail-value {
      margin-top: 6px;
      font-size: 22px;
      font-weight: 950;
      overflow-wrap: anywhere;
    }
    .status-ok { color: var(--ok); }
    .status-blocked, .status-degraded { color: var(--warn); }
    .status-error, .status-unhealthy { color: var(--bad); }
    .raw-drawer {
      border: 2px solid var(--line);
      background: var(--panel);
      box-shadow: 6px 6px 0 var(--hot);
      overflow: hidden;
    }
    .raw-drawer .panel-head {
      margin: 0;
      padding: 14px 16px;
      background: var(--text);
      color: #fff;
      border-bottom: 2px solid var(--line);
    }
    .raw-drawer pre {
      max-height: 380px;
      background: #fff;
      color: var(--text);
      border: 0;
      border-radius: 0;
      padding: 16px;
    }
    @keyframes grid-drift {
      from { background-position: 0 0, 0 0, 0 0; }
      to { background-position: 88px 44px, 44px 88px, 120px 60px; }
    }
    @keyframes slice-drift {
      from { transform: translateX(0); }
      to { transform: translateX(-34px); }
    }
    @keyframes scan-line {
      from { transform: rotate(-3deg) translateX(0); }
      to { transform: rotate(-3deg) translateX(-24px); }
    }
    @keyframes pulse-dot {
      0%, 100% { background: var(--acid); }
      50% { background: #fff; }
    }
    @media (prefers-reduced-motion: reduce) {
      .motion-grid,
      .motion-grid::after,
      .topbar::before,
      .pulse-dot { animation: none; }
    }
    @media (max-width: 980px) {
      .admin-shell { grid-template-columns: 1fr; }
      .ops-rail {
        position: relative;
        top: 0;
        min-height: auto;
        transform: none;
      }
      .ops-rail > * { transform: none; }
      .rail-nav { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .rail-nav a { transform: none !important; }
      .topbar { grid-template-columns: 1fr; }
      .metric-wall { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .control-grid { grid-template-columns: 1fr; }
      .ops-panel,
      .ops-panel:nth-child(2),
      .ops-panel.wide {
        transform: none;
        width: 100%;
      }
    }
    @media (max-width: 640px) {
      .admin-shell { padding: 10px; gap: 14px; }
      .rail-nav { grid-template-columns: 1fr; }
      .topbar { padding: 14px; }
      .auth-panel { grid-template-columns: 1fr; }
      .incident-strip { grid-template-columns: 1fr; }
      .metric-wall,
      .detail-grid { grid-template-columns: 1fr; }
      .metric:nth-child(n) { transform: none; }
    }
  </style>
</head>
<body>
  <div class="motion-grid" aria-hidden="true"></div>
  <div class="admin-shell">
    <aside class="ops-rail">
      <div class="brand-lockup">
        <div class="brand-mark">TP</div>
        <div>
          <p class="eyebrow">Gateway Ops</p>
          <h1>Tabbit Pool Admin</h1>
        </div>
      </div>
      <nav class="rail-nav" aria-label="Admin sections">
        <a class="active" href="#admin-root">Overview</a>
        <a href="#accounts-panel">Accounts</a>
        <a href="#raw-panel">Telemetry</a>
      </nav>
      <div class="rail-status">
        <span class="pulse-dot" aria-hidden="true"></span>
        <span id="rail-state">LOCKED</span>
      </div>
    </aside>
    <main id="admin-root" class="console-stage">
      <header class="topbar">
        <div class="title-block">
          <div class="kicker-row">
            <span>Protocol Pool</span>
            <span id="key-source">Key source: unknown</span>
          </div>
          <h2>Gateway Control Surface</h2>
          <p class="subline" id="state-path">StateDir: waiting for status</p>
        </div>
        <form class="auth-panel" id="admin-auth">
          <input id="admin-key" name="key" type="password" autocomplete="current-password" placeholder="Gateway API key" aria-label="Gateway API key">
          <button type="submit">刷新状态</button>
        </form>
      </header>
      <section class="incident-strip">
        <span>Gateway state</span>
        <strong id="status-word">等待认证</strong>
        <span id="observed-at">Observed: --</span>
      </section>
      <section class="metric-wall" id="summary"></section>
      <div class="control-grid">
        <section class="ops-panel" id="accounts-panel">
          <div class="panel-head">
            <h2>账号池</h2>
            <span class="panel-tag">POOL</span>
          </div>
          <div class="detail-grid" id="accounts"></div>
        </section>
        <section class="ops-panel">
          <div class="panel-head">
            <h2>协议</h2>
            <span class="panel-tag">PROTO</span>
          </div>
          <div class="detail-grid" id="protocol"></div>
        </section>
        <section class="ops-panel wide">
          <div class="panel-head">
            <h2>安全态势</h2>
            <span class="panel-tag">SAFE</span>
          </div>
          <div class="detail-grid" id="security"></div>
        </section>
      </div>
      <section class="raw-drawer" id="raw-panel">
        <div class="panel-head">
          <h2>原始摘要</h2>
          <span class="panel-tag">JSON</span>
        </div>
        <pre id="raw">等待认证</pre>
      </section>
    </main>
  </div>
  <script>
    const form = document.getElementById("admin-auth");
    const keyInput = document.getElementById("admin-key");
    const raw = document.getElementById("raw");
    const summary = document.getElementById("summary");
    const accounts = document.getElementById("accounts");
    const protocol = document.getElementById("protocol");
    const security = document.getElementById("security");
    const railState = document.getElementById("rail-state");
    const statusWord = document.getElementById("status-word");
    const observedAt = document.getElementById("observed-at");
    const keySource = document.getElementById("key-source");
    const statePath = document.getElementById("state-path");
    keyInput.value = sessionStorage.getItem("tabbit-admin-key") || "";
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => {
        if (char === "&") return "&amp;";
        if (char === "<") return "&lt;";
        if (char === ">") return "&gt;";
        if (char === '"') return "&quot;";
        return "&#39;";
      });
    }
    function safeClassName(value) {
      const text = String(value || "");
      return /^[A-Za-z0-9_-]+$/.test(text) ? text : "";
    }
    function item(label, value, className = "") {
      const cssClass = safeClassName(className);
      return "<article class=\\"metric " + cssClass + "\\"><span class=\\"metric-label\\">" + escapeHtml(label) + "</span><p class=\\"metric-value\\">" + escapeHtml(value) + "</p></article>";
    }
    function detail(label, value, className = "") {
      const cssClass = safeClassName(className);
      return "<div class=\\"detail-item " + cssClass + "\\"><div class=\\"detail-label\\">" + escapeHtml(label) + "</div><div class=\\"detail-value\\">" + escapeHtml(value) + "</div></div>";
    }
    function boolLabel(value) {
      return value === true ? "ON" : "OFF";
    }
    function render(data) {
      const statusText = String(data.status || "unknown");
      const statusToken = safeClassName(statusText) || "unknown";
      const statusClass = "tone-" + statusToken + " status-" + statusToken;
      railState.textContent = statusText.toUpperCase();
      statusWord.textContent = statusText;
      observedAt.textContent = "Observed: " + (data.observedAt || "--");
      keySource.textContent = "Key source: " + (data.gatewayApiKey?.source || "unknown");
      statePath.textContent = "StateDir: " + (data.stateDir || "unknown");
      summary.innerHTML = [
        item("Gateway", data.status || "unknown", statusClass),
        item("Accounts", data.health?.accounts?.total ?? 0),
        item("Active", data.health?.accounts?.active ?? 0),
        item("API Key", data.gatewayApiKey?.status || "unknown"),
      ].join("");
      const accountSummary = data.health?.accounts || {};
      accounts.innerHTML = [
        detail("Total", accountSummary.total ?? 0),
        detail("Active", accountSummary.active ?? 0, "status-ok"),
        detail("Login Expired", accountSummary.byStatus?.login_expired ?? 0, "status-degraded"),
        detail("Suspect", accountSummary.byStatus?.suspect ?? 0, "status-error"),
      ].join("");
      protocol.innerHTML = [
        detail("Enabled", boolLabel(data.protocol?.enabled === true)),
        detail("Send Path", boolLabel(data.protocol?.sendPathConfigured === true)),
        detail("Session Verify", boolLabel(data.protocol?.sessionVerifyPathConfigured === true)),
        detail("Model Catalog", boolLabel(data.protocol?.modelCatalogPathConfigured === true)),
      ].join("");
      security.innerHTML = [
        detail("Key", data.gatewayApiKey?.status || "unknown"),
        detail("Source", data.gatewayApiKey?.source || "unknown"),
        detail("Base URL", boolLabel(data.protocol?.baseUrlConfigured === true)),
        detail("Sign Key", boolLabel(data.protocol?.signKeyPathConfigured === true)),
      ].join("");
      raw.textContent = JSON.stringify(data, null, 2);
    }
    async function loadStatus(event) {
      if (event) event.preventDefault();
      const key = keyInput.value.trim();
      if (key) sessionStorage.setItem("tabbit-admin-key", key);
      raw.textContent = "加载中";
      const response = await fetch("/admin/api/status", { headers: key ? { "x-api-key": key } : {} });
      const body = await response.json();
      if (!response.ok) {
        railState.textContent = "LOCKED";
        statusWord.textContent = "认证失败";
        observedAt.textContent = "Observed: --";
        raw.textContent = JSON.stringify(body, null, 2);
        return;
      }
      render(body);
    }
    form.addEventListener("submit", loadStatus);
    if (keyInput.value) loadStatus();
  </script>
</body>
</html>`;
}

export function sseData(payload) {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  return `data: ${data}\n\n`;
}

function sseEvent(event, payload) {
  return `event: ${event}\n${sseData(payload)}`;
}

export function writeSse(res, events) {
  const text = events.join("");
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function streamErrorShape(error = {}) {
  return {
    message: error.message || "Stream failed.",
    type: "api_error",
    code: error.code || error.category || "stream_error",
  };
}

function streamErrorEvents(error) {
  return [
    sseData({ error: streamErrorShape(error) }),
    sseData("[DONE]"),
  ];
}

function responsesStreamErrorEvents(body = {}, error = {}) {
  return [
    sseEvent("response.failed", {
      type: "response.failed",
      response: {
        ...body,
        status: "failed",
        error: streamErrorShape(error),
      },
    }),
    sseData("[DONE]"),
  ];
}

function anthropicStreamErrorEvents(error = {}) {
  const streamError = streamErrorShape(error);
  return [
    sseEvent("error", {
      type: "error",
      error: {
        type: streamError.type,
        message: streamError.message,
      },
      metadata: { code: streamError.code },
    }),
  ];
}

async function* abortableAsyncIterable(iterable, signal) {
  const iterator = iterable?.[Symbol.asyncIterator]?.();
  if (!iterator) return;
  let removeAbortListener = () => {};
  let returned = false;
  const requestIteratorReturn = () => {
    if (!returned) {
      returned = true;
      try {
        const result = iterator.return?.();
        if (result && typeof result.catch === "function") result.catch(() => {});
      } catch {
        // Ignore cancellation cleanup failures after the downstream client is gone.
      }
    }
  };
  const abortPromise = signal
    ? new Promise((resolve) => {
      const onAbort = () => resolve({ aborted: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    })
    : null;

  try {
    for (;;) {
      const nextPromise = Promise.resolve(iterator.next()).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const result = abortPromise ? await Promise.race([nextPromise, abortPromise]) : await nextPromise;
      if (result?.aborted) {
        requestIteratorReturn();
        return;
      }
      if (result.error) throw result.error;
      if (result.value?.done) return;
      yield result.value.value;
    }
  } finally {
    removeAbortListener();
    if (signal?.aborted) requestIteratorReturn();
  }
}

export async function writeSseStream(res, events, { errorEvents = streamErrorEvents } = {}) {
  const closeController = new AbortController();
  let completed = false;
  const onClose = () => {
    if (!completed) closeController.abort();
  };
  res.on("close", onClose);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  const eventSource = typeof events === "function" ? events(closeController.signal) : events;
  const iterator = eventSource[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      if (closeController.signal.aborted) break;
      res.write(next.value);
    }
  } catch (error) {
    if (!closeController.signal.aborted && !res.destroyed) {
      for (const event of errorEvents(error)) {
        res.write(event);
      }
    }
  }
  completed = true;
  res.off("close", onClose);
  if (closeController.signal.aborted) await iterator.return?.();
  if (!res.writableEnded && !res.destroyed) res.end();
}

function isSuccessStatus(status) {
  return Number.isInteger(status) && status >= 200 && status < 300;
}

function isAsyncIterable(value) {
  return value && typeof value[Symbol.asyncIterator] === "function";
}

function streamTextDeltas(stream = {}) {
  return Array.isArray(stream?.deltas)
    ? stream.deltas.filter((delta) => typeof delta === "string" && delta.length > 0)
    : [];
}

function responseTextItem(body = {}, text = "", status = "completed") {
  const existing = Array.isArray(body.output) ? body.output.find((item) => item?.type === "message") : null;
  return {
    id: existing?.id || `msg_${body.id}`,
    type: "message",
    status,
    role: existing?.role || "assistant",
    content: text ? [{ type: "output_text", text }] : [],
  };
}

function responseTextStartEvents(body = {}) {
  const item = responseTextItem(body, "", "in_progress");
  return [
    sseEvent("response.output_item.added", {
      type: "response.output_item.added",
      response_id: body.id,
      output_index: 0,
      item,
    }),
    sseEvent("response.content_part.added", {
      type: "response.content_part.added",
      response_id: body.id,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "" },
    }),
  ];
}

function responseTextDoneEvents(body = {}, text = "") {
  const item = responseTextItem(body, text, "completed");
  return [
    sseEvent("response.output_text.done", {
      type: "response.output_text.done",
      response_id: body.id,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text,
    }),
    sseEvent("response.content_part.done", {
      type: "response.content_part.done",
      response_id: body.id,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text },
    }),
    sseEvent("response.output_item.done", {
      type: "response.output_item.done",
      response_id: body.id,
      output_index: 0,
      item,
    }),
  ];
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function normalizeToolCallStreamDelta(value) {
  if (!value || typeof value !== "object" || value.type !== "tool_call_delta") return null;
  const index = Number.isInteger(value.index) ? value.index : 0;
  const argumentsDelta = firstDefined(
    value.argumentsDelta,
    value.arguments_delta,
    value.inputJsonDelta,
    value.input_json_delta,
    value.partialJson,
    value.partial_json,
    value.arguments,
  );
  const delta = { index };
  if (value.id) delta.id = String(value.id);
  if (value.name) delta.name = String(value.name);
  if (argumentsDelta !== undefined && argumentsDelta !== null) delta.argumentsDelta = String(argumentsDelta);
  return delta.id || delta.name || Object.hasOwn(delta, "argumentsDelta") ? delta : null;
}

function chatToolCallStreamDelta(value) {
  const delta = normalizeToolCallStreamDelta(value);
  if (!delta) return null;
  const functionDelta = {};
  if (delta.name) functionDelta.name = delta.name;
  if (Object.hasOwn(delta, "argumentsDelta")) functionDelta.arguments = delta.argumentsDelta;
  const toolCall = {
    index: delta.index,
    ...(delta.id ? { id: delta.id } : {}),
    type: "function",
    function: functionDelta,
  };
  return toolCall;
}

function chatToolCallDeltas(choice = {}) {
  const toolCalls = Array.isArray(choice.message?.tool_calls) ? choice.message.tool_calls : [];
  return toolCalls.map((toolCall, index) => ({
    index,
    id: toolCall.id,
    type: toolCall.type || "function",
    function: {
      name: toolCall.function?.name || toolCall.name || "",
      arguments: toolCall.function?.arguments || toolCall.arguments || "",
    },
  }));
}

export function chatCompletionToSseEvents(body = {}, stream = {}) {
  const choice = body.choices?.[0] || {};
  const text = choice.message?.content || "";
  const textDeltas = streamTextDeltas(stream);
  const contentDeltas = textDeltas.length ? textDeltas : (text ? [text] : []);
  const toolCallDeltas = chatToolCallDeltas(choice);
  const base = {
    id: body.id,
    object: "chat.completion.chunk",
    created: body.created,
    model: body.model,
  };

  return [
    sseData({
      ...base,
      choices: [{ index: choice.index ?? 0, delta: { role: "assistant" }, finish_reason: null }],
    }),
    ...contentDeltas.map((delta) => sseData({
      ...base,
      choices: [{ index: choice.index ?? 0, delta: { content: delta }, finish_reason: null }],
    })),
    ...toolCallDeltas.map((toolCall) => sseData({
      ...base,
      choices: [{ index: choice.index ?? 0, delta: { tool_calls: [toolCall] }, finish_reason: null }],
    })),
    sseData({
      ...base,
      choices: [{ index: choice.index ?? 0, delta: {}, finish_reason: choice.finish_reason || "stop" }],
    }),
    sseData("[DONE]"),
  ].filter(Boolean);
}

async function* chatCompletionToStreamingSseEvents(body = {}, stream = {}, { signal = null } = {}) {
  const choice = body.choices?.[0] || {};
  const base = {
    id: body.id,
    object: "chat.completion.chunk",
    created: body.created,
    model: body.model,
  };
  yield sseData({
    ...base,
    choices: [{ index: choice.index ?? 0, delta: { role: "assistant" }, finish_reason: null }],
  });
  let sawToolCalls = false;
  for await (const delta of abortableAsyncIterable(stream.deltas, signal)) {
    if (typeof delta === "string" && delta.length > 0) {
      yield sseData({
        ...base,
        choices: [{ index: choice.index ?? 0, delta: { content: delta }, finish_reason: null }],
      });
      continue;
    }
    const toolCall = chatToolCallStreamDelta(delta);
    if (toolCall) {
      sawToolCalls = true;
      yield sseData({
        ...base,
        choices: [{ index: choice.index ?? 0, delta: { tool_calls: [toolCall] }, finish_reason: null }],
      });
    }
  }
  const finishReason = sawToolCalls ? "tool_calls" : choice.finish_reason || "stop";
  yield sseData({
    ...base,
    choices: [{ index: choice.index ?? 0, delta: {}, finish_reason: finishReason }],
  });
  yield sseData("[DONE]");
}

export function responsesToSseEvents(body = {}, stream = {}) {
  const textDeltas = streamTextDeltas(stream);
  const contentDeltas = textDeltas.length ? textDeltas : (body.output_text ? [body.output_text] : []);
  const text = contentDeltas.join("");
  return [
    sseEvent("response.created", {
      type: "response.created",
      response: {
        id: body.id,
        object: body.object,
        created_at: body.created_at,
        model: body.model,
      },
    }),
    ...(contentDeltas.length ? responseTextStartEvents(body) : []),
    ...contentDeltas.map((delta) => sseEvent("response.output_text.delta", {
      type: "response.output_text.delta",
      response_id: body.id,
      item_id: responseTextItem(body).id,
      output_index: 0,
      content_index: 0,
      delta,
    })),
    ...(contentDeltas.length ? responseTextDoneEvents(body, text) : []),
    ...responsesFunctionCallEvents(body),
    sseEvent("response.completed", {
      type: "response.completed",
      response: body,
    }),
    sseData("[DONE]"),
  ].filter(Boolean);
}

function responsesFunctionCallEvents(body = {}) {
  const output = Array.isArray(body.output) ? body.output : [];
  return output.flatMap((item, outputIndex) => {
    if (item?.type !== "function_call") return [];
    const argumentsText = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {});
    const startedItem = {
      ...item,
      arguments: "",
      status: item.status === "completed" ? "in_progress" : item.status,
    };
    const events = [
      sseEvent("response.output_item.added", {
        type: "response.output_item.added",
        response_id: body.id,
        output_index: outputIndex,
        item: startedItem,
      }),
    ];
    if (argumentsText) {
      events.push(sseEvent("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        response_id: body.id,
        item_id: item.id,
        output_index: outputIndex,
        delta: argumentsText,
      }));
    }
    events.push(sseEvent("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      response_id: body.id,
      item_id: item.id,
      output_index: outputIndex,
      arguments: argumentsText,
    }));
    events.push(sseEvent("response.output_item.done", {
      type: "response.output_item.done",
      response_id: body.id,
      output_index: outputIndex,
      item,
    }));
    return events;
  });
}

async function* responsesToStreamingSseEvents(body = {}, stream = {}, { signal = null } = {}) {
  const toolCalls = new Map();
  let textStarted = false;
  let text = "";
  const ensureToolCall = (delta) => {
    const current = toolCalls.get(delta.index);
    if (current) {
      if (delta.id && current.call_id.startsWith("call_")) current.call_id = delta.id;
      if (delta.name && !current.name) current.name = delta.name;
      return current;
    }
    const callId = delta.id || `call_${delta.index}`;
    const state = {
      index: delta.index,
      output_index: toolCalls.size,
      id: `fc_${callId}`,
      call_id: callId,
      name: delta.name || "",
      arguments: "",
    };
    toolCalls.set(delta.index, state);
    return state;
  };

  yield sseEvent("response.created", {
    type: "response.created",
    response: {
      id: body.id,
      object: body.object,
      created_at: body.created_at,
      model: body.model,
    },
  });
  for await (const delta of abortableAsyncIterable(stream.deltas, signal)) {
    if (typeof delta === "string" && delta.length > 0) {
      if (!textStarted) {
        textStarted = true;
        for (const event of responseTextStartEvents(body)) yield event;
      }
      text += delta;
      yield sseEvent("response.output_text.delta", {
        type: "response.output_text.delta",
        response_id: body.id,
        item_id: responseTextItem(body).id,
        output_index: 0,
        content_index: 0,
        delta,
      });
    }
    const toolDelta = normalizeToolCallStreamDelta(delta);
    if (toolDelta) {
      const existing = toolCalls.get(toolDelta.index);
      const toolCall = ensureToolCall(toolDelta);
      if (!existing) {
        yield sseEvent("response.output_item.added", {
          type: "response.output_item.added",
          response_id: body.id,
          output_index: toolCall.output_index,
          item: {
            id: toolCall.id,
            type: "function_call",
            call_id: toolCall.call_id,
            name: toolCall.name,
            arguments: "",
            status: "in_progress",
          },
        });
      }
      if (Object.hasOwn(toolDelta, "argumentsDelta")) {
        toolCall.arguments += toolDelta.argumentsDelta;
        yield sseEvent("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          response_id: body.id,
          item_id: toolCall.id,
          output_index: toolCall.output_index,
          delta: toolDelta.argumentsDelta,
        });
      }
    }
  }
  if (textStarted) {
    for (const event of responseTextDoneEvents(body, text)) yield event;
  }
  for (const toolCall of [...toolCalls.values()].sort((left, right) => left.output_index - right.output_index)) {
    const item = {
      id: toolCall.id,
      type: "function_call",
      call_id: toolCall.call_id,
      name: toolCall.name,
      arguments: toolCall.arguments,
      status: "completed",
    };
    yield sseEvent("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      response_id: body.id,
      item_id: toolCall.id,
      output_index: toolCall.output_index,
      arguments: toolCall.arguments,
    });
    yield sseEvent("response.output_item.done", {
      type: "response.output_item.done",
      response_id: body.id,
      output_index: toolCall.output_index,
      item,
    });
  }
  for (const event of responsesFunctionCallEvents(body)) {
    yield event;
  }
  yield sseEvent("response.completed", {
    type: "response.completed",
    response: body,
  });
  yield sseData("[DONE]");
}

function anthropicContentBlockStartShape(block = {}) {
  if (block.type === "text") return { type: "text", text: "" };
  if (block.type === "tool_use" || block.type === "server_tool_use") {
    return { type: block.type, id: block.id, name: block.name, input: {} };
  }
  return block;
}

function anthropicContentBlockDelta(block = {}) {
  if (block.type === "text" && block.text) {
    return { type: "text_delta", text: block.text };
  }
  if ((block.type === "tool_use" || block.type === "server_tool_use") && block.input) {
    return { type: "input_json_delta", partial_json: JSON.stringify(block.input) };
  }
  return null;
}

export function anthropicMessageToSseEvents(body = {}, stream = {}) {
  const streamDeltas = streamTextDeltas(stream);
  const content = Array.isArray(body.content) && body.content.length
    ? body.content
    : (streamDeltas.length ? [{ type: "text", text: streamDeltas.join("") }] : []);
  const streamTextBlockIndex = streamDeltas.length ? content.findIndex((block) => block?.type === "text") : -1;
  const events = [
    sseEvent("message_start", {
      type: "message_start",
      message: { ...body, content: [] },
    }),
  ];

  content.forEach((block, index) => {
    events.push(sseEvent("content_block_start", {
      type: "content_block_start",
      index,
      content_block: anthropicContentBlockStartShape(block),
    }));

    const deltas = index === streamTextBlockIndex
      ? streamDeltas.map((text) => ({ type: "text_delta", text }))
      : [anthropicContentBlockDelta(block)].filter(Boolean);
    for (const delta of deltas) {
      if (delta) {
        events.push(sseEvent("content_block_delta", {
          type: "content_block_delta",
          index,
          delta,
        }));
      }
    }

    events.push(sseEvent("content_block_stop", {
      type: "content_block_stop",
      index,
    }));
  });

  events.push(sseEvent("message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: body.stop_reason || "end_turn",
      stop_sequence: body.stop_sequence ?? null,
    },
    usage: body.usage || { input_tokens: 0, output_tokens: 0 },
  }));

  events.push(sseEvent("message_stop", { type: "message_stop" }));
  return events;
}

async function* anthropicMessageToStreamingSseEvents(body = {}, stream = {}, { signal = null } = {}) {
  yield sseEvent("message_start", {
    type: "message_start",
    message: { ...body, content: [] },
  });

  let nextBlockIndex = 0;
  let textBlockIndex = null;
  let textBlockOpen = false;
  let sawToolUse = false;
  const toolBlocks = new Map();

  const stopTextBlock = function* stopTextBlock() {
    if (!textBlockOpen) return;
    yield sseEvent("content_block_stop", {
      type: "content_block_stop",
      index: textBlockIndex,
    });
    textBlockOpen = false;
  };

  const startTextBlock = function* startTextBlock() {
    if (textBlockOpen) return;
    if (textBlockIndex === null) {
      textBlockIndex = nextBlockIndex;
      nextBlockIndex += 1;
    }
    yield sseEvent("content_block_start", {
      type: "content_block_start",
      index: textBlockIndex,
      content_block: { type: "text", text: "" },
    });
    textBlockOpen = true;
  };

  const ensureToolBlock = function* ensureToolBlock(delta) {
    const existing = toolBlocks.get(delta.index);
    if (existing) {
      if (delta.id && existing.id.startsWith("toolu_")) existing.id = delta.id;
      if (delta.name && !existing.name) existing.name = delta.name;
      return existing;
    }
    for (const event of stopTextBlock()) yield event;
    const toolBlock = {
      blockIndex: nextBlockIndex,
      id: delta.id || `toolu_${delta.index}`,
      name: delta.name || "",
      stopped: false,
    };
    nextBlockIndex += 1;
    toolBlocks.set(delta.index, toolBlock);
    sawToolUse = true;
    yield sseEvent("content_block_start", {
      type: "content_block_start",
      index: toolBlock.blockIndex,
      content_block: {
        type: "tool_use",
        id: toolBlock.id,
        name: toolBlock.name,
        input: {},
      },
    });
    return toolBlock;
  };

  for await (const delta of abortableAsyncIterable(stream.deltas, signal)) {
    if (typeof delta === "string" && delta.length > 0) {
      for (const event of startTextBlock()) yield event;
      yield sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: textBlockIndex,
        delta: { type: "text_delta", text: delta },
      });
      continue;
    }
    const toolDelta = normalizeToolCallStreamDelta(delta);
    if (toolDelta) {
      let toolBlock = toolBlocks.get(toolDelta.index);
      if (!toolBlock) {
        const ensureIterator = ensureToolBlock(toolDelta);
        for (;;) {
          const next = ensureIterator.next();
          if (next.done) {
            toolBlock = next.value;
            break;
          }
          yield next.value;
        }
      } else {
        if (toolDelta.id && toolBlock.id.startsWith("toolu_")) toolBlock.id = toolDelta.id;
        if (toolDelta.name && !toolBlock.name) toolBlock.name = toolDelta.name;
      }
      if (Object.hasOwn(toolDelta, "argumentsDelta")) {
        yield sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: toolBlock.blockIndex,
          delta: { type: "input_json_delta", partial_json: toolDelta.argumentsDelta },
        });
      }
    }
  }
  for (const event of stopTextBlock()) yield event;
  for (const toolBlock of [...toolBlocks.values()].sort((left, right) => left.blockIndex - right.blockIndex)) {
    if (!toolBlock.stopped) {
      yield sseEvent("content_block_stop", {
        type: "content_block_stop",
        index: toolBlock.blockIndex,
      });
      toolBlock.stopped = true;
    }
  }
  yield sseEvent("message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: sawToolUse ? "tool_use" : body.stop_reason || "end_turn",
      stop_sequence: body.stop_sequence ?? null,
    },
    usage: body.usage || { input_tokens: 0, output_tokens: 0 },
  });
  yield sseEvent("message_stop", { type: "message_stop" });
}

async function readRequestText(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text;
}

export async function readJson(req) {
  const text = await readRequestText(req);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidJsonError();
  }
}

export function openAiHttpError(status, message, type = "invalid_request_error", code = "invalid_request") {
  return { status, body: { error: { message, type, code } } };
}

export function isAuthorized(req, apiKey = DEFAULT_API_KEY) {
  const expected = String(apiKey || DEFAULT_API_KEY);
  const authorization = req.headers.authorization || "";
  if (authorization === `Bearer ${expected}`) return true;
  if (req.headers["x-api-key"] === expected) return true;
  return false;
}

function writeError(res, error) {
  writeJson(res, error.status, error.body);
}

function toOpenAiModel(model = {}) {
  return {
    id: model.id || "tabbit/priority",
    object: "model",
    owned_by: "tabbit",
    tabbit_selected_model: model.selectedModel ?? model.tabbit_selected_model ?? null,
    supports_tools: Boolean(model.supports_tools),
    supports_images: Boolean(model.supports_images),
    model_access_type: String(model.model_access_type || "unknown"),
  };
}

async function listModels(modelsProvider) {
  if (!modelsProvider) return [toOpenAiModel({ id: "tabbit/priority", model_access_type: "priority" })];
  if (typeof modelsProvider === "function") return await modelsProvider();
  if (typeof modelsProvider.listModels === "function") return await modelsProvider.listModels();
  return [];
}

function requireCompatHandler(compat, handlerName) {
  const handler = compat?.[handlerName];
  if (typeof handler !== "function") {
    throw new Error(`compat.${handlerName} is required`);
  }
  return handler.bind(compat);
}

async function resolveHealth(health) {
  if (typeof health === "function") return await health();
  return health || {};
}

async function handleCompatJsonRoute(req, res, compat, handlerName, { streamKind = null } = {}) {
  const body = await readJson(req);
  const result = await requireCompatHandler(compat, handlerName)(body);
  if (body?.stream === true && isSuccessStatus(result.status)) {
    if (streamKind === "chat" && isAsyncIterable(result.stream?.deltas)) {
      await writeSseStream(res, (signal) => chatCompletionToStreamingSseEvents(result.body, result.stream, { signal }));
      return;
    }
    if (streamKind === "responses" && isAsyncIterable(result.stream?.deltas)) {
      await writeSseStream(res, (signal) => responsesToStreamingSseEvents(result.body, result.stream, { signal }), {
        errorEvents: (error) => responsesStreamErrorEvents(result.body, error),
      });
      return;
    }
    if (streamKind === "anthropic" && isAsyncIterable(result.stream?.deltas)) {
      await writeSseStream(res, (signal) => anthropicMessageToStreamingSseEvents(result.body, result.stream, { signal }), {
        errorEvents: anthropicStreamErrorEvents,
      });
      return;
    }
    if (streamKind === "chat") {
      writeSse(res, chatCompletionToSseEvents(result.body, result.stream));
      return;
    }
    if (streamKind === "responses") {
      writeSse(res, responsesToSseEvents(result.body, result.stream));
      return;
    }
    if (streamKind === "anthropic") {
      writeSse(res, anthropicMessageToSseEvents(result.body, result.stream));
      return;
    }
  }
  writeJson(res, result.status, result.body);
}

async function resolveAdminStatus(admin) {
  if (typeof admin?.statusProvider === "function") return await admin.statusProvider();
  return { status: "unknown" };
}

export function createProtocolPoolServer({ apiKey = DEFAULT_API_KEY, compat, modelsProvider = null, health = null, admin = null } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/health") {
        writeJson(res, 200, { status: "ok", mode: "protocol-pool", ...(await resolveHealth(health)) });
        return;
      }

      if (admin && req.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
        writeHtml(res, 200, adminDashboardHtml());
        return;
      }

      if (admin && url.pathname.startsWith("/admin/api/") && !isAuthorized(req, apiKey)) {
        writeError(res, openAiHttpError(401, "Missing or invalid API key.", "authentication_error", "invalid_api_key"));
        return;
      }

      if (admin && req.method === "GET" && url.pathname === "/admin/api/status") {
        writeJson(res, 200, await resolveAdminStatus(admin));
        return;
      }

      if (url.pathname.startsWith("/v1/") && !isAuthorized(req, apiKey)) {
        writeError(res, openAiHttpError(401, "Missing or invalid API key.", "authentication_error", "invalid_api_key"));
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        const models = await listModels(modelsProvider);
        writeJson(res, 200, { object: "list", data: models.map((model) => toOpenAiModel(model)) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        await handleCompatJsonRoute(req, res, compat, "handleChatCompletions", { streamKind: "chat" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/responses") {
        await handleCompatJsonRoute(req, res, compat, "handleResponses", { streamKind: "responses" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/messages") {
        await handleCompatJsonRoute(req, res, compat, "handleMessages", { streamKind: "anthropic" });
        return;
      }

      writeError(res, openAiHttpError(404, "Route not found.", "invalid_request_error", "not_found"));
    } catch (error) {
      if (res.writableEnded) return;
      if (error?.code === "INVALID_JSON") {
        writeError(res, openAiHttpError(400, "Request body must be valid JSON.", "invalid_request_error", "invalid_json"));
        return;
      }
      writeError(res, openAiHttpError(500, "Internal server error.", "api_error", "internal_error"));
    }
  });
}
