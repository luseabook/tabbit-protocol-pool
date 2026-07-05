import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { isDefaultRoutedModel, isUnsupportedModelMetadata } from "./model-access.js";
import { redactAccountForDisplay, redactAccountsForDisplay } from "./observability.js";

const DEFAULT_API_KEY = "sk-tabbit-local";
const ADMIN_ACCOUNT_STATUSES = new Set(["active", "disabled", "cooldown", "quota_exhausted", "login_expired", "suspect"]);
const ADMIN_ACCOUNT_ACCESS_TIERS = new Set(["", "unknown", "free", "pro"]);

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
  <title>Tabbit 池管理后台</title>
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
    [hidden] { display: none !important; }
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
    textarea, select {
      min-width: 0;
      border: 2px solid var(--line);
      border-radius: 0;
      padding: 10px;
      font: inherit;
      background: #fff;
    }
    textarea {
      min-height: 80px;
      resize: vertical;
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
    .rail-nav a,
    .rail-nav button {
      color: var(--text);
      text-decoration: none;
      border: 2px solid var(--line);
      background: #fff;
      padding: 10px 12px;
      font-weight: 800;
      box-shadow: 3px 3px 0 var(--line);
      height: auto;
      text-align: left;
      border-radius: 0;
    }
    .rail-nav a:nth-child(2),
    .rail-nav button:nth-child(2) { transform: translateX(10px); }
    .rail-nav a:nth-child(3),
    .rail-nav button:nth-child(3) { transform: translateX(-4px); }
    .rail-nav a.active,
    .rail-nav button.active {
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
    .login-screen {
      display: none;
    }
    .login-context,
    .login-form-panel {
      min-width: 0;
    }
    .login-context {
      background: #111111;
      color: #fff;
      padding: 34px;
      display: grid;
      align-content: space-between;
      gap: 28px;
    }
    .login-context .brand-mark {
      color: var(--text);
      background: var(--acid);
    }
    .login-context .eyebrow {
      color: #cfcfcf;
    }
    .login-copy {
      display: grid;
      gap: 12px;
      max-width: 520px;
    }
    .login-label {
      margin: 0;
      width: max-content;
      max-width: 100%;
      border: 1px solid rgba(255, 255, 255, 0.32);
      padding: 5px 9px;
      font-size: 12px;
      font-weight: 850;
      color: #f2f2f2;
    }
    .login-copy h2 {
      margin: 0;
      font-size: 38px;
      line-height: 1.1;
      font-weight: 900;
      color: #fff;
    }
    .login-copy p:last-child {
      margin: 0;
      color: #d7d7d7;
      font-size: 15px;
      line-height: 1.7;
    }
    .login-assurance {
      display: grid;
      gap: 8px;
      color: #f5f5f5;
      font-size: 13px;
      font-weight: 750;
    }
    .login-assurance span {
      width: max-content;
      max-width: 100%;
      border-left: 4px solid var(--accent);
      padding: 6px 10px;
      background: rgba(255, 255, 255, 0.08);
    }
    .login-form-panel {
      background: #fff;
      padding: 34px;
      display: grid;
      align-content: center;
      gap: 24px;
    }
    .login-form-head {
      display: grid;
      gap: 8px;
    }
    .login-form-head h2 {
      margin: 0;
      font-size: 26px;
      line-height: 1.2;
      font-weight: 900;
    }
    .login-message {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.5;
    }
    .login-message.is-error {
      color: var(--bad);
      font-weight: 800;
    }
    .field-stack {
      display: grid;
      gap: 7px;
    }
    .field-stack label {
      font-size: 13px;
      font-weight: 850;
      color: var(--text);
    }
    .login-note {
      margin: 0;
      border-top: 1px solid var(--line-soft);
      padding-top: 14px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.6;
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
    .auth-slot {
      position: relative;
      z-index: 1;
      display: grid;
      gap: 10px;
      align-self: end;
    }
    .auth-panel {
      position: relative;
      z-index: 1;
      display: grid;
      grid-template-columns: 1fr;
      gap: 14px;
      border: 2px solid var(--line);
      background: #fff;
      padding: 0;
      box-shadow: none;
    }
    .auth-panel input {
      height: 44px;
      border: 2px solid var(--line);
      border-radius: 0;
      font-weight: 700;
      color: var(--text);
    }
    .auth-panel button {
      height: 46px;
      border: 2px solid var(--line);
      border-radius: 0;
      background: var(--text);
      color: #fff;
      font-weight: 900;
      box-shadow: 4px 4px 0 var(--accent);
      white-space: nowrap;
    }
    .auth-panel button[type="button"] {
      background: #fff;
      color: var(--text);
      box-shadow: 3px 3px 0 var(--accent);
    }
    .session-actions {
      position: relative;
      z-index: 1;
      justify-self: end;
      border: 2px solid var(--line);
      background: #fff;
      padding: 10px;
      box-shadow: 5px 5px 0 var(--line);
    }
    .session-actions button {
      height: 44px;
      border: 2px solid var(--line);
      border-radius: 0;
      background: var(--text);
      color: #fff;
      font-weight: 900;
      box-shadow: 3px 3px 0 var(--accent);
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
    .admin-form-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-top: 12px;
    }
    .admin-form-grid textarea {
      grid-column: span 2;
    }
    .admin-form-grid button {
      height: auto;
      min-height: 44px;
      border: 2px solid var(--line);
      border-radius: 0;
      background: var(--text);
      color: #fff;
      font-weight: 900;
      box-shadow: 3px 3px 0 var(--acid);
    }
    .admin-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
      background: #fff;
    }
    .admin-table th,
    .admin-table td {
      border: 2px solid var(--line-soft);
      padding: 8px;
      text-align: left;
      vertical-align: top;
      overflow-wrap: anywhere;
    }
    .admin-table th {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
    }
    .admin-table select {
      width: 100%;
    }
    .admin-table button {
      height: 34px;
      border: 2px solid var(--line);
      border-radius: 0;
      background: var(--text);
      color: #fff;
      font-weight: 900;
      box-shadow: 2px 2px 0 var(--acid);
      white-space: nowrap;
    }
    .admin-message {
      margin-top: 10px;
      color: var(--muted);
      font-weight: 800;
      min-height: 20px;
    }
    .admin-view {
      display: grid;
      gap: 18px;
    }
    .key-secret-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 10px;
      align-items: center;
      margin-top: 12px;
    }
    .key-secret-row input {
      height: 44px;
      border: 2px solid var(--line);
      border-radius: 0;
      font-weight: 800;
    }
    .key-secret-row button {
      height: 44px;
      border: 2px solid var(--line);
      border-radius: 0;
      background: var(--text);
      color: #fff;
      font-weight: 900;
      box-shadow: 3px 3px 0 var(--acid);
      white-space: nowrap;
    }
    .motion-grid { display: none; }
    .admin-shell {
      min-height: 100vh;
      grid-template-columns: 240px minmax(0, 1fr);
      gap: 0;
      padding: 0;
      background: #f5f7fb;
    }
    .ops-rail {
      position: sticky;
      top: 0;
      min-height: 100vh;
      border: 0;
      border-right: 1px solid var(--line-soft);
      box-shadow: none;
      transform: none;
      padding: 18px;
      background: #fff;
    }
    .ops-rail > * { transform: none; }
    .rail-nav a,
    .rail-nav button {
      border: 1px solid transparent;
      border-radius: 6px;
      box-shadow: none;
      transform: none !important;
      background: #fff;
    }
    .rail-nav a.active,
    .rail-nav button.active {
      background: #050505;
      color: #fff;
    }
    .rail-status {
      border: 1px solid var(--line-soft);
      border-radius: 6px;
      background: #f5f7fb;
    }
    .console-stage {
      padding: 20px 24px 28px;
      gap: 16px;
    }
    .topbar {
      min-height: 112px;
      width: 100%;
      max-width: 100%;
      min-width: 0;
      border: 1px solid var(--line-soft);
      border-radius: 8px;
      box-shadow: none;
      padding: 18px;
      grid-template-columns: minmax(0, 1fr) minmax(320px, 460px);
      overflow: visible;
    }
    .topbar::before { display: none; }
    .title-block,
    .auth-slot,
    .admin-view,
    .ops-panel,
    .ops-panel.wide,
    .account-page-head,
    .account-stat-grid {
      min-width: 0;
      max-width: 100%;
    }
    .ops-panel.wide {
      width: 100%;
      box-shadow: none;
      transform: none;
    }
    .topbar h2 {
      font-size: 30px;
      line-height: 1.1;
      font-weight: 850;
    }
    .kicker-row span {
      border: 1px solid var(--line-soft);
      border-radius: 999px;
      padding: 3px 8px;
    }
    .auth-panel,
    .session-actions {
      border: 1px solid var(--line-soft);
      border-radius: 8px;
      box-shadow: none;
    }
    .auth-panel input,
    .auth-panel button,
    .session-actions button,
    .key-secret-row input,
    .key-secret-row button,
    .admin-form-grid button,
    .admin-table button {
      border-radius: 6px;
      box-shadow: none;
    }
    .incident-strip,
    .ops-panel,
    .raw-drawer {
      border: 1px solid var(--line-soft);
      border-radius: 8px;
      box-shadow: none;
      transform: none !important;
    }
    .account-page-head {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 16px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--line-soft);
    }
    .account-page-head h2 {
      margin: 0 0 6px;
      font-size: 22px;
    }
    .account-page-head p,
    .section-caption p {
      margin: 0;
      color: var(--muted);
      line-height: 1.5;
    }
    .inline-actions {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .inline-actions button {
      height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--text);
      box-shadow: none;
    }
    .account-stat-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(120px, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .table-scroll {
      overflow-x: auto;
      border: 1px solid var(--line-soft);
      border-radius: 8px;
      background: #fff;
    }
    .account-table {
      min-width: 980px;
      border: 0;
    }
    .account-table th {
      background: #f5f7fb;
      color: #4a5568;
      font-size: 12px;
    }
    .account-table th,
    .account-table td {
      border-color: var(--line-soft);
      vertical-align: middle;
      padding: 11px 10px;
    }
    .account-table th:nth-child(1),
    .account-table td:nth-child(1) {
      min-width: 128px;
      white-space: nowrap;
    }
    .account-table th:nth-child(2),
    .account-table td:nth-child(2) {
      min-width: 190px;
      white-space: nowrap;
    }
    .account-table th:nth-child(5),
    .account-table td:nth-child(5) {
      min-width: 145px;
    }
    .account-stat-grid .detail-label {
      text-transform: none;
    }
    .status-pill,
    .tier-pill {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 800;
      white-space: nowrap;
    }
    .status-active,
    .tier-pro {
      background: #e8f7ef;
      color: #04643a;
    }
    .status-disabled,
    .status-login_expired,
    .status-suspect {
      background: #fff0f0;
      color: #a80f22;
    }
    .status-cooldown,
    .status-quota_exhausted {
      background: #fff6df;
      color: #8a4a00;
    }
    .tier-free {
      background: #edf3ff;
      color: #1f4f99;
    }
    .tier-unknown {
      background: #f1f3f5;
      color: #4a5568;
    }
    .row-actions {
      display: grid;
      grid-template-columns: minmax(112px, 1fr) auto;
      gap: 8px;
      align-items: center;
    }
    .row-actions select {
      height: 34px;
      padding: 4px 8px;
      border: 1px solid var(--line-soft);
      border-radius: 6px;
    }
    .row-actions button {
      height: 34px;
      padding: 0 12px;
      border: 1px solid var(--line);
      background: var(--text);
      color: #fff;
    }
    .account-import-band {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--line-soft);
    }
    .section-caption {
      display: grid;
      gap: 4px;
      margin-bottom: 12px;
    }
    .section-caption h3 {
      margin: 0;
      font-size: 16px;
    }
    .account-import-grid {
      grid-template-columns: minmax(160px, 0.8fr) minmax(200px, 1fr) 130px minmax(280px, 1.4fr) auto;
      align-items: stretch;
    }
    .account-import-grid textarea {
      grid-column: auto;
      min-height: 44px;
      height: 44px;
    }
    .empty-state {
      display: grid;
      gap: 4px;
      padding: 28px;
      border: 1px dashed var(--line-soft);
      border-radius: 8px;
      color: var(--muted);
      background: #fff;
    }
    .empty-state strong {
      color: var(--text);
      font-size: 16px;
    }
    body.auth-mode {
      background: #eef1f5;
    }
    body.auth-mode .motion-grid,
    body.auth-mode .ops-rail,
    body.auth-mode .console-stage,
    body.auth-mode .admin-view,
    body.auth-mode .incident-strip,
    body.auth-mode .metric-wall,
    body.auth-mode .control-grid,
    body.auth-mode .raw-drawer,
    body.auth-mode .session-actions {
      display: none !important;
    }
    body.auth-mode .admin-shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 1fr;
      place-items: center;
      padding: 24px;
      background: #eef1f5;
    }
    body.auth-mode .login-screen {
      width: min(960px, 100%);
      min-height: min(620px, calc(100vh - 48px));
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(360px, 0.82fr);
      border: 2px solid var(--line);
      border-radius: 8px;
      background: #fff;
      box-shadow: 8px 8px 0 rgba(5, 5, 5, 0.18);
      overflow: hidden;
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
      body.auth-mode .login-screen {
        grid-template-columns: 1fr;
        min-height: auto;
      }
      .login-context {
        min-height: 300px;
      }
      .ops-rail {
        position: relative;
        top: 0;
        min-height: auto;
        transform: none;
      }
      .ops-rail > * { transform: none; }
      .rail-nav { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .rail-nav a,
      .rail-nav button { transform: none !important; }
      .topbar { grid-template-columns: 1fr; }
      .metric-wall { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .control-grid { grid-template-columns: 1fr; }
      .account-stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .account-import-grid { grid-template-columns: 1fr 1fr; }
      .account-import-grid textarea { grid-column: 1 / -1; }
      .account-import-grid button { grid-column: 1 / -1; }
      .ops-panel,
      .ops-panel:nth-child(2),
      .ops-panel.wide {
        transform: none;
        width: 100%;
      }
    }
    @media (max-width: 640px) {
      .admin-shell { padding: 10px; gap: 14px; }
      body.auth-mode .admin-shell { padding: 12px; }
      .login-context,
      .login-form-panel {
        padding: 22px;
      }
      .login-copy h2 {
        font-size: 30px;
      }
      .rail-nav { grid-template-columns: 1fr; }
      .topbar { padding: 14px; }
      .auth-panel { grid-template-columns: 1fr; }
      .session-actions { justify-self: stretch; }
      .session-actions button { width: 100%; }
      .incident-strip { grid-template-columns: 1fr; }
      .metric-wall,
      .detail-grid,
      .account-stat-grid { grid-template-columns: 1fr; }
      .admin-form-grid { grid-template-columns: 1fr; }
      .admin-form-grid textarea { grid-column: auto; }
      .account-page-head { display: grid; }
      .account-import-grid button { grid-column: auto; }
      .key-secret-row { grid-template-columns: 1fr; }
      .metric:nth-child(n) { transform: none; }
    }
  </style>
</head>
<body class="auth-mode">
  <div class="motion-grid" aria-hidden="true"></div>
  <div class="admin-shell">
    <div class="login-screen" aria-labelledby="login-title">
      <div class="login-context" aria-label="后台访问状态">
        <div class="brand-lockup login-brand">
          <div class="brand-mark">TP</div>
          <div>
            <p class="eyebrow">Tabbit 协议池</p>
            <h1>管理后台</h1>
          </div>
        </div>
        <div class="login-copy">
          <p class="login-label">受控后台入口</p>
          <h2 id="login-title">账号池网关控制台</h2>
          <p>登录后进入运行总览、账号池和请求 Key 管理。</p>
        </div>
        <div class="login-assurance" aria-label="访问约束">
          <span>HTTPS 访问</span>
          <span>后台账号密码</span>
          <span>未登录不加载运行数据</span>
        </div>
      </div>
      <div class="login-form-panel" aria-label="登录表单">
        <div class="login-form-head">
          <p class="eyebrow">管理员登录</p>
          <h2>进入管理后台</h2>
          <p class="login-message" id="login-message" role="status">请先登录</p>
        </div>
        <form class="auth-panel" id="admin-auth">
          <div class="field-stack">
            <label for="admin-user">后台账号</label>
            <input id="admin-user" name="username" type="text" autocomplete="username" placeholder="请输入后台账号" aria-label="后台账号">
          </div>
          <div class="field-stack">
            <label for="admin-password">后台密码</label>
            <input id="admin-password" name="password" type="password" autocomplete="current-password" placeholder="请输入后台密码" aria-label="后台密码">
          </div>
          <button type="submit">登录后台</button>
        </form>
        <p class="login-note">凭据仅保存在当前页面内存，刷新或退出后需要重新登录。</p>
      </div>
    </div>
    <aside class="ops-rail">
      <div class="brand-lockup">
        <div class="brand-mark">TP</div>
        <div>
          <p class="eyebrow">网关运维</p>
          <h1>Tabbit 池管理后台</h1>
        </div>
      </div>
      <nav class="rail-nav" aria-label="后台分区">
        <button class="active" type="button" id="nav-dashboard" data-view-target="dashboard">总览</button>
        <button type="button" id="nav-accounts" data-view-target="accounts">账号池</button>
        <button type="button" id="nav-key" data-view-target="key">请求 Key</button>
        <button type="button" id="nav-raw" data-view-target="raw">运行摘要</button>
      </nav>
      <div class="rail-status">
        <span class="pulse-dot" aria-hidden="true"></span>
        <span id="rail-state">未登录</span>
      </div>
    </aside>
    <main id="admin-root" class="console-stage">
      <header class="topbar">
        <div class="title-block">
          <div class="kicker-row">
            <span>协议池</span>
            <span id="key-source">后台登录</span>
          </div>
          <h2 id="page-title">管理后台登录</h2>
          <p class="subline" id="state-path">登录后显示运行状态</p>
          <p class="subline" id="auth-message">请输入后台账号和密码</p>
        </div>
        <div class="auth-slot">
          <div class="session-actions" id="session-actions" hidden>
            <button type="button" id="admin-logout">退出登录</button>
          </div>
        </div>
      </header>
      <section class="admin-view" id="view-dashboard" hidden>
        <section class="incident-strip" id="status-panel" hidden>
          <span>网关状态</span>
          <strong id="status-word">等待认证</strong>
          <span id="observed-at">观测时间：--</span>
        </section>
        <section class="metric-wall" id="summary" hidden></section>
        <div class="control-grid" id="control-panels" hidden>
          <section class="ops-panel" id="accounts-panel">
            <div class="panel-head">
              <h2>账号池</h2>
              <span class="panel-tag">账号</span>
            </div>
            <div class="detail-grid" id="accounts"></div>
          </section>
          <section class="ops-panel">
            <div class="panel-head">
              <h2>协议</h2>
              <span class="panel-tag">协议</span>
            </div>
            <div class="detail-grid" id="protocol"></div>
          </section>
          <section class="ops-panel wide">
            <div class="panel-head">
              <h2>安全态势</h2>
              <span class="panel-tag">安全</span>
            </div>
            <div class="detail-grid" id="security"></div>
          </section>
        </div>
      </section>
      <section class="admin-view" id="view-accounts" hidden>
        <section class="ops-panel wide" id="account-management-panel" hidden>
          <div class="account-page-head">
            <div>
              <h2>账号池</h2>
              <p>管理 Tabbit 会话、账号状态和 Pro 权限。Session 只写入密钥目录，不在后台回显。</p>
            </div>
            <div class="inline-actions">
              <button type="button" id="accounts-refresh">刷新</button>
            </div>
          </div>
          <div class="account-stat-grid" id="account-stats"></div>
          <div id="account-table"></div>
          <div class="account-import-band">
            <div class="section-caption">
              <h3>导入账号</h3>
              <p>选择账号当前套餐。当前产品只区分免费版和 Pro，模型是否可用由运行时错误和模型目录判断。</p>
            </div>
            <div class="admin-form-grid account-import-grid">
              <input id="account-import-id" type="text" placeholder="账号 ID（可选，留空自动生成）" aria-label="账号 ID（可选）">
              <input id="account-import-email" type="email" placeholder="邮箱或备注（可选）" aria-label="邮箱或备注（可选）">
              <input id="account-import-chat-session-id" type="text" placeholder="Chat session ID（可选）" aria-label="Chat session ID（可选）">
              <select id="account-import-access-tier" aria-label="访问层级">
                <option value="unknown">未知</option>
                <option value="free">免费版</option>
                <option value="pro">Pro</option>
              </select>
              <textarea id="account-import-session" placeholder="粘贴 Tabbit session / cookie" aria-label="Tabbit session"></textarea>
              <button type="button" id="account-import-submit">导入并启用</button>
            </div>
          </div>
          <div class="admin-message" id="account-message"></div>
        </section>
      </section>
      <section class="admin-view" id="view-key" hidden>
        <section class="ops-panel wide" id="key-management-panel" hidden>
          <div class="panel-head">
            <h2>请求 Key 管理</h2>
            <span class="panel-tag">密钥</span>
          </div>
          <div class="detail-grid" id="key-management-summary"></div>
          <div class="key-secret-row">
            <input id="key-secret-input" type="password" readonly aria-label="请求 Key">
            <button type="button" id="key-secret-toggle" aria-label="显示请求 Key">显示</button>
            <button type="button" id="key-secret-copy">复制</button>
          </div>
          <div class="admin-form-grid">
            <button type="button" id="key-rotate-submit">生成新请求 Key</button>
          </div>
          <div class="admin-message" id="key-message"></div>
        </section>
      </section>
      <section class="admin-view" id="view-raw" hidden>
        <section class="raw-drawer" id="raw-panel" hidden>
          <div class="panel-head">
            <h2>运行摘要</h2>
            <span class="panel-tag">摘要</span>
          </div>
          <pre id="raw">请先登录</pre>
        </section>
      </section>
    </main>
  </div>
  <script>
    const form = document.getElementById("admin-auth");
    const userInput = document.getElementById("admin-user");
    const passwordInput = document.getElementById("admin-password");
    const sessionActions = document.getElementById("session-actions");
    const logoutButton = document.getElementById("admin-logout");
    const raw = document.getElementById("raw");
    const summary = document.getElementById("summary");
    const accounts = document.getElementById("accounts");
    const protocol = document.getElementById("protocol");
    const security = document.getElementById("security");
    const railState = document.getElementById("rail-state");
    const pageTitle = document.getElementById("page-title");
    const statusWord = document.getElementById("status-word");
    const observedAt = document.getElementById("observed-at");
    const keySource = document.getElementById("key-source");
    const statePath = document.getElementById("state-path");
    const authMessage = document.getElementById("auth-message");
    const loginMessage = document.getElementById("login-message");
    const statusPanel = document.getElementById("status-panel");
    const controlPanels = document.getElementById("control-panels");
    const rawPanel = document.getElementById("raw-panel");
    const navDashboard = document.getElementById("nav-dashboard");
    const navAccounts = document.getElementById("nav-accounts");
    const navKey = document.getElementById("nav-key");
    const navRaw = document.getElementById("nav-raw");
    const viewDashboard = document.getElementById("view-dashboard");
    const viewAccounts = document.getElementById("view-accounts");
    const viewKey = document.getElementById("view-key");
    const viewRaw = document.getElementById("view-raw");
    const accountManagementPanel = document.getElementById("account-management-panel");
    const keyManagementPanel = document.getElementById("key-management-panel");
    const accountStats = document.getElementById("account-stats");
    const accountTable = document.getElementById("account-table");
    const accountsRefreshButton = document.getElementById("accounts-refresh");
    const accountImportId = document.getElementById("account-import-id");
    const accountImportEmail = document.getElementById("account-import-email");
    const accountImportChatSessionId = document.getElementById("account-import-chat-session-id");
    const accountImportAccessTier = document.getElementById("account-import-access-tier");
    const accountImportSession = document.getElementById("account-import-session");
    const accountImportSubmit = document.getElementById("account-import-submit");
    const accountMessage = document.getElementById("account-message");
    const keyManagementSummary = document.getElementById("key-management-summary");
    const keySecretInput = document.getElementById("key-secret-input");
    const keySecretToggle = document.getElementById("key-secret-toggle");
    const keySecretCopy = document.getElementById("key-secret-copy");
    const keyRotateSubmit = document.getElementById("key-rotate-submit");
    const keyMessage = document.getElementById("key-message");
    const views = {
      dashboard: viewDashboard,
      accounts: viewAccounts,
      key: viewKey,
      raw: viewRaw,
    };
    const navItems = [
      { name: "dashboard", element: navDashboard },
      { name: "accounts", element: navAccounts },
      { name: "key", element: navKey },
      { name: "raw", element: navRaw },
    ];
    const authContent = [viewDashboard, viewAccounts, viewKey, viewRaw, statusPanel, summary, controlPanels, rawPanel, accountManagementPanel, keyManagementPanel];
    const accountStatuses = ["active", "disabled", "cooldown", "quota_exhausted", "login_expired", "suspect"];
    const viewCopy = {
      dashboard: { title: "总览", message: "查看网关、账号池和协议运行状态" },
      accounts: { title: "账号池", message: "管理 Tabbit 会话、状态和账号套餐" },
      key: { title: "请求 Key", message: "查看、复制和轮换客户端调用 Key" },
      raw: { title: "运行摘要", message: "查看脱敏后的后台状态 JSON" },
    };
    let activeBasicCredential = "";
    let activeView = "dashboard";
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
      return value === true ? "已启用" : "未配置";
    }
    function statusLabel(value) {
      const text = String(value || "unknown");
      return {
        ok: "正常",
        blocked: "阻塞",
        degraded: "降级",
        error: "错误",
        unhealthy: "异常",
        unknown: "未知",
      }[text] || text;
    }
    function keyStatusLabel(value) {
      const text = String(value || "unknown");
      return {
        configured: "已配置",
        default: "默认",
        unknown: "未知",
      }[text] || text;
    }
    function sourceLabel(value) {
      const text = String(value || "unknown");
      return {
        env: "环境变量",
        state_secret: "状态密钥",
        default: "默认",
        unknown: "未知",
      }[text] || text;
    }
    function formBasicCredential() {
      const username = userInput.value.trim();
      const password = passwordInput.value;
      if (!username || !password) return "";
      return btoa(username + ":" + password);
    }
    function currentBasicCredential() {
      const fromForm = formBasicCredential();
      if (fromForm) activeBasicCredential = fromForm;
      return activeBasicCredential;
    }
    function setAuthContentVisible(visible) {
      for (const element of authContent) {
        if (element) element.hidden = !visible;
      }
    }
    function setMessage(element, text, isError = false) {
      if (!element) return;
      element.textContent = text || "";
      if (element.style) element.style.color = isError ? "#d11d3a" : "";
    }
    function setNavActive(name) {
      for (const item of navItems) {
        if (!item.element) continue;
        if (item.name === name) {
          item.element.className = "active";
          item.element.setAttribute("aria-current", "page");
        } else {
          item.element.className = "";
          item.element.removeAttribute("aria-current");
        }
      }
    }
    function setViewVisible(name) {
      activeView = name;
      for (const [viewName, element] of Object.entries(views)) {
        if (element) element.hidden = viewName !== name;
      }
      statusPanel.hidden = name !== "dashboard";
      summary.hidden = name !== "dashboard";
      controlPanels.hidden = name !== "dashboard";
      accountManagementPanel.hidden = name !== "accounts";
      keyManagementPanel.hidden = name !== "key";
      rawPanel.hidden = name !== "raw";
      setNavActive(name);
      if (activeBasicCredential) {
        pageTitle.textContent = viewCopy[name]?.title || "管理后台";
        authMessage.textContent = viewCopy[name]?.message || "已登录";
      }
    }
    async function showView(name, event) {
      if (event?.preventDefault) event.preventDefault();
      if (!activeBasicCredential) return;
      setViewVisible(name);
      if (name === "key" && !keySecretInput.value) {
        await loadKeyDetails();
      }
    }
    function renderKeySummary(data = {}) {
      keyManagementSummary.innerHTML = [
        detail("当前状态", keyStatusLabel(data.gatewayApiKey?.status)),
        detail("密钥来源", sourceLabel(data.gatewayApiKey?.source)),
        detail("密钥内容", keySecretInput.value ? "已读取，默认隐藏" : "进入 Key 页面后读取"),
      ].join("");
    }
    function renderKeyDetails(data = {}) {
      keySecretInput.value = data.apiKey || "";
      keySecretInput.type = "password";
      keySecretToggle.textContent = "显示";
      keySecretCopy.disabled = !keySecretInput.value;
      keyManagementSummary.innerHTML = [
        detail("密钥来源", sourceLabel(data.apiKeySource || data.source)),
        detail("存储位置", data.secretRef || "未知"),
        detail("显示状态", "默认隐藏"),
      ].join("");
    }
    function accountStatusLabel(value) {
      const text = String(value || "unknown");
      return {
        active: "活跃",
        disabled: "已禁用",
        cooldown: "冷却中",
        quota_exhausted: "额度耗尽",
        login_expired: "登录失效",
        suspect: "疑似异常",
        provisioning: "导入中",
        unknown: "未知",
      }[text] || text;
    }
    function accountTierLabel(value) {
      const text = String(value || "unknown").toLowerCase();
      return {
        pro: "Pro",
        premium: "Pro",
        free: "免费版",
        unknown: "未知",
      }[text] || text;
    }
    function accountTierClass(value) {
      const text = String(value || "unknown").toLowerCase();
      return text === "pro" || text === "premium" ? "tier-pro" : "tier-" + safeClassName(text || "unknown");
    }
    function accountTimeLabel(value) {
      if (!value) return "--";
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return String(value);
      return date.toLocaleString("zh-CN", { hour12: false });
    }
    function accountLastSeen(account = {}) {
      return account.lastSuccessAt || account.lastCheckinAt || account.lastMaintainedAt || account.lastVerifiedAt || account.lastProvisionedAt || "";
    }
    function accountErrorLabel(account = {}) {
      const error = account.lastError;
      if (!error) return "无";
      const category = error.category || "unknown";
      const message = error.message ? "：" + error.message : "";
      return category + message;
    }
    function renderAccountStats(items = []) {
      const rows = Array.isArray(items) ? items : [];
      const countStatus = (status) => rows.filter((account) => account.status === status).length;
      const proCount = rows.filter((account) => ["pro", "premium"].includes(String(account.accessTier || "").toLowerCase())).length;
      accountStats.innerHTML = [
        detail("总账号", rows.length),
        detail("活跃", countStatus("active"), "status-ok"),
        detail("冷却中", countStatus("cooldown"), "status-degraded"),
        detail("登录失效", countStatus("login_expired"), "status-error"),
        detail("Pro", proCount),
      ].join("");
    }
    function renderAccountTable(items = []) {
      const rows = Array.isArray(items) ? items : [];
      if (!rows.length) {
        accountTable.innerHTML = "<div class=\\"empty-state\\"><strong>暂无账号</strong><span>导入第一个 Tabbit session 后，这里会显示账号状态和操作。</span></div>";
        renderAccountStats([]);
        return;
      }
      const statusOptions = (selected) => accountStatuses.map((status) => {
        const selectedAttr = status === selected ? " selected" : "";
        return "<option value=\\"" + escapeHtml(status) + "\\"" + selectedAttr + ">" + escapeHtml(accountStatusLabel(status)) + "</option>";
      }).join("");
      renderAccountStats(rows);
      accountTable.innerHTML = "<div class=\\"table-scroll\\"><table class=\\"admin-table account-table\\"><thead><tr><th>账号 ID</th><th>邮箱/备注</th><th>套餐</th><th>状态</th><th>最近使用</th><th>最近错误</th><th>操作</th></tr></thead><tbody>" + rows.map((account) => {
        const id = escapeHtml(account.id || "");
        const rawStatus = account.status || "unknown";
        const statusClass = "status-" + safeClassName(rawStatus);
        const tierClass = accountTierClass(account.accessTier);
        return "<tr><td><strong>" + id + "</strong></td><td>" + escapeHtml(account.email || "--") + "</td><td><span class=\\"tier-pill " + tierClass + "\\">" + escapeHtml(accountTierLabel(account.accessTier)) + "</span></td><td><span class=\\"status-pill " + statusClass + "\\">" + escapeHtml(accountStatusLabel(rawStatus)) + "</span></td><td>" + escapeHtml(accountTimeLabel(accountLastSeen(account))) + "</td><td>" + escapeHtml(accountErrorLabel(account)) + "</td><td><div class=\\"row-actions\\"><select data-account-status=\\"" + id + "\\" aria-label=\\"更新 " + id + " 状态\\">" + statusOptions(account.status) + "</select><button type=\\"button\\" data-account-update=\\"" + id + "\\">更新</button></div></td></tr>";
      }).join("") + "</tbody></table></div>";
    }
    function locked(text = "请先登录") {
      activeBasicCredential = "";
      document.body.className = "auth-mode";
      form.hidden = false;
      sessionActions.hidden = true;
      railState.textContent = "未登录";
      pageTitle.textContent = "管理后台登录";
      statusWord.textContent = text;
      observedAt.textContent = "观测时间：--";
      keySource.textContent = "后台登录";
      statePath.textContent = "登录后显示运行状态";
      authMessage.textContent = text;
      loginMessage.textContent = text;
      loginMessage.className = text === "认证失败" ? "login-message is-error" : "login-message";
      summary.innerHTML = "";
      accounts.innerHTML = "";
      protocol.innerHTML = "";
      security.innerHTML = "";
      accountTable.innerHTML = "";
      accountStats.innerHTML = "";
      keyManagementSummary.innerHTML = "";
      keySecretInput.value = "";
      keySecretInput.type = "password";
      keySecretToggle.textContent = "显示";
      keySecretCopy.disabled = true;
      setMessage(accountMessage, "");
      setMessage(keyMessage, "");
      raw.textContent = text;
      setAuthContentVisible(false);
      setNavActive("dashboard");
    }
    function render(data) {
      const statusText = String(data.status || "unknown");
      const statusToken = safeClassName(statusText) || "unknown";
      const statusClass = "tone-" + statusToken + " status-" + statusToken;
      document.body.className = "admin-mode";
      form.hidden = true;
      sessionActions.hidden = false;
      railState.textContent = "已登录";
      statusWord.textContent = statusLabel(statusText);
      observedAt.textContent = "观测时间：" + (data.observedAt || "--");
      keySource.textContent = "密钥来源：" + sourceLabel(data.gatewayApiKey?.source);
      statePath.textContent = "状态目录：" + (data.stateDir || "未知");
      authMessage.textContent = "已登录，可查看运行状态";
      loginMessage.textContent = "请先登录";
      loginMessage.className = "login-message";
      summary.innerHTML = [
        item("网关", statusLabel(data.status), statusClass),
        item("账号总数", data.health?.accounts?.total ?? 0),
        item("活跃账号", data.health?.accounts?.active ?? 0),
        item("接口密钥", keyStatusLabel(data.gatewayApiKey?.status)),
      ].join("");
      const accountSummary = data.health?.accounts || {};
      accounts.innerHTML = [
        detail("总数", accountSummary.total ?? 0),
        detail("活跃", accountSummary.active ?? 0, "status-ok"),
        detail("登录过期", accountSummary.byStatus?.login_expired ?? 0, "status-degraded"),
        detail("疑似异常", accountSummary.byStatus?.suspect ?? 0, "status-error"),
      ].join("");
      protocol.innerHTML = [
        detail("协议启用", boolLabel(data.protocol?.enabled === true)),
        detail("发送路径", boolLabel(data.protocol?.sendPathConfigured === true)),
        detail("会话校验", boolLabel(data.protocol?.sessionVerifyPathConfigured === true)),
        detail("模型目录", boolLabel(data.protocol?.modelCatalogPathConfigured === true)),
      ].join("");
      security.innerHTML = [
        detail("密钥", keyStatusLabel(data.gatewayApiKey?.status)),
        detail("来源", sourceLabel(data.gatewayApiKey?.source)),
        detail("基础地址", boolLabel(data.protocol?.baseUrlConfigured === true)),
        detail("签名密钥", boolLabel(data.protocol?.signKeyPathConfigured === true)),
      ].join("");
      renderAccountTable(data.accounts || []);
      renderKeySummary(data);
      raw.textContent = JSON.stringify(data, null, 2);
      passwordInput.value = "";
      setViewVisible("dashboard");
    }
    async function adminFetch(path, { method = "GET", body = null } = {}) {
      const basic = currentBasicCredential();
      if (!basic) {
        locked("请输入后台账号和密码");
        throw new Error("请先登录");
      }
      const response = await fetch(path, {
        method,
        headers: {
          Authorization: "Basic " + basic,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const payload = await response.json();
      if (!response.ok) {
        if (response.status === 401) locked("认证失败");
        throw new Error(payload?.error?.message || "操作失败");
      }
      return payload;
    }
    async function loadKeyDetails() {
      setMessage(keyMessage, "正在读取请求 Key");
      try {
        const result = await adminFetch("/admin/api/key");
        renderKeyDetails(result);
        setMessage(keyMessage, "请求 Key 已读取，默认隐藏");
      } catch (error) {
        setMessage(keyMessage, error.message || "读取失败", true);
      }
    }
    async function loadStatus(event) {
      if (event) event.preventDefault();
      const basic = currentBasicCredential();
      if (!basic) {
        locked("请输入后台账号和密码");
        return;
      }
      raw.textContent = "加载中";
      const response = await fetch("/admin/api/status", { headers: { Authorization: "Basic " + basic } });
      const body = await response.json();
      if (!response.ok) {
        locked("认证失败");
        return;
      }
      render(body);
    }
    async function importAccountSession() {
      setMessage(accountMessage, "正在导入");
      try {
        await adminFetch("/admin/api/accounts/import-session", {
          method: "POST",
          body: {
            accountId: accountImportId.value.trim(),
            email: accountImportEmail.value.trim(),
            chatSessionId: accountImportChatSessionId.value.trim(),
            accessTier: accountImportAccessTier.value,
            session: accountImportSession.value,
          },
        });
        accountImportSession.value = "";
        accountImportChatSessionId.value = "";
        accountImportId.value = "";
        accountImportEmail.value = "";
        accountImportAccessTier.value = "unknown";
        setMessage(accountMessage, "会话已导入，页面已刷新");
        await loadStatus();
        setViewVisible("accounts");
      } catch (error) {
        setMessage(accountMessage, error.message || "导入失败", true);
      }
    }
    async function updateAccountStatus(accountId) {
      const selector = Array.from(accountTable.querySelectorAll("[data-account-status]")).find((element) => element.getAttribute("data-account-status") === accountId);
      const status = selector?.value || "";
      setMessage(accountMessage, "正在更新");
      try {
        await adminFetch("/admin/api/accounts/status", {
          method: "POST",
          body: { accountId, status },
        });
        setMessage(accountMessage, "账号状态已更新");
        await loadStatus();
        setViewVisible("accounts");
      } catch (error) {
        setMessage(accountMessage, error.message || "更新失败", true);
      }
    }
    async function rotateGatewayKey() {
      setMessage(keyMessage, "正在生成新请求 Key");
      try {
        const result = await adminFetch("/admin/api/key/rotate", { method: "POST", body: {} });
        renderKeyDetails(result);
        setMessage(keyMessage, "新 Key 已写入 " + (result.secretRef || "状态密钥") + "，默认隐藏，可显示或复制");
        await loadStatus();
        setViewVisible("key");
      } catch (error) {
        setMessage(keyMessage, error.message || "生成失败", true);
      }
    }
    function toggleKeySecret() {
      const visible = keySecretInput.type === "text";
      keySecretInput.type = visible ? "password" : "text";
      keySecretToggle.textContent = visible ? "显示" : "隐藏";
    }
    async function copyKeySecret() {
      if (!keySecretInput.value) return;
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(keySecretInput.value);
      }
      setMessage(keyMessage, "请求 Key 已复制");
    }
    function logout() {
      passwordInput.value = "";
      locked();
    }
    form.addEventListener("submit", loadStatus);
    navDashboard.addEventListener("click", (event) => showView("dashboard", event));
    navAccounts.addEventListener("click", (event) => showView("accounts", event));
    navKey.addEventListener("click", (event) => showView("key", event));
    navRaw.addEventListener("click", (event) => showView("raw", event));
    accountImportSubmit.addEventListener("click", importAccountSession);
    keySecretToggle.addEventListener("click", toggleKeySecret);
    keySecretCopy.addEventListener("click", copyKeySecret);
    keyRotateSubmit.addEventListener("click", rotateGatewayKey);
    accountsRefreshButton.addEventListener("click", async () => {
      setMessage(accountMessage, "正在刷新");
      await loadStatus();
      setViewVisible("accounts");
      setMessage(accountMessage, "账号池已刷新");
    });
    accountTable.addEventListener("click", (event) => {
      const button = event.target?.closest?.("[data-account-update]");
      if (!button) return;
      updateAccountStatus(button.getAttribute("data-account-update"));
    });
    logoutButton.addEventListener("click", logout);
    locked();
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

function safeEqualText(actual, expected) {
  const actualBuffer = Buffer.from(String(actual ?? ""), "utf8");
  const expectedBuffer = Buffer.from(String(expected ?? ""), "utf8");
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function parseBasicAuthorization(req) {
  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  let decoded = "";
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

function isAdminBasicAuthorized(req, admin) {
  const expectedUsername = admin?.username || "";
  const expectedPassword = admin?.password || "";
  if (!expectedUsername || !expectedPassword) return false;
  const credentials = parseBasicAuthorization(req);
  if (!credentials) return false;
  const usernameMatches = safeEqualText(credentials.username, expectedUsername);
  const passwordMatches = safeEqualText(credentials.password, expectedPassword);
  return usernameMatches && passwordMatches;
}

function isAdminApiAuthorized(req, apiKey, admin) {
  return isAuthorized(req, apiKey) || isAdminBasicAuthorized(req, admin);
}

function writeError(res, error) {
  writeJson(res, error.status, error.body);
}

async function resolveAdminAccounts(admin) {
  if (typeof admin?.accountsProvider !== "function") return [];
  return redactAccountsForDisplay(await admin.accountsProvider());
}

function sanitizeAdminKeyRotation(result = {}) {
  return {
    changed: Boolean(result.changed),
    secretRef: result.secretRef || "secrets/gateway-api-key.txt",
    apiKeySource: result.apiKeySource || "state_secret",
    ...(result.apiKey ? { apiKey: result.apiKey } : {}),
    restartRequired: Boolean(result.restartRequired),
  };
}

function sanitizeAdminKeyDetails(result = {}) {
  return {
    apiKey: result.apiKey || "",
    secretRef: result.secretRef || "secrets/gateway-api-key.txt",
    apiKeySource: result.apiKeySource || result.source || "unknown",
    restartRequired: Boolean(result.restartRequired),
  };
}

function publicModelId(model = {}) {
  return String(model.id || "tabbit/priority").replace(/^tabbit\//i, "").trim();
}

function isPublicModel(model = {}) {
  if (isUnsupportedModelMetadata(model)) return false;
  const aliases = [
    model.id,
    model.selectedModel,
    model.selected_model,
    model.tabbit_selected_model,
    model.displayName,
    model.display_name,
    model.model,
    model.name,
    model.value,
  ];
  return !aliases.filter((alias) => alias !== undefined && alias !== null && alias !== "").some((alias) => isDefaultRoutedModel(alias));
}

function toOpenAiModel(model = {}) {
  return {
    id: publicModelId(model),
    object: "model",
    owned_by: "tabbit",
    tabbit_selected_model: model.selectedModel ?? model.tabbit_selected_model ?? null,
    supports_tools: Boolean(model.supports_tools),
    supports_images: Boolean(model.supports_images),
    model_access_type: String(model.model_access_type || "unknown"),
    requires_premium: Boolean(model.requires_premium || model.requiresPremium),
  };
}

async function listModels(modelsProvider) {
  if (!modelsProvider) return [];
  if (typeof modelsProvider === "function") return (await modelsProvider()).filter(isPublicModel);
  if (typeof modelsProvider.listModels === "function") return (await modelsProvider.listModels()).filter(isPublicModel);
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
  const status = typeof admin?.statusProvider === "function" ? await admin.statusProvider() : { status: "unknown" };
  if (typeof admin?.accountsProvider !== "function") return status;
  return { ...status, accounts: await resolveAdminAccounts(admin) };
}

export function createProtocolPoolServer({ apiKey = DEFAULT_API_KEY, compat, modelsProvider = null, health = null, admin = null } = {}) {
  function activeApiKey() {
    if (typeof admin?.apiKeyProvider === "function") {
      const value = admin.apiKeyProvider();
      if (value) return value;
    }
    return apiKey;
  }
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

      if (admin && url.pathname.startsWith("/admin/api/") && !isAdminApiAuthorized(req, activeApiKey(), admin)) {
        writeError(res, openAiHttpError(401, "Missing or invalid API key.", "authentication_error", "invalid_api_key"));
        return;
      }

      if (admin && req.method === "GET" && url.pathname === "/admin/api/status") {
        writeJson(res, 200, await resolveAdminStatus(admin));
        return;
      }

      if (admin && req.method === "GET" && url.pathname === "/admin/api/accounts") {
        writeJson(res, 200, { accounts: await resolveAdminAccounts(admin) });
        return;
      }

      if (admin && req.method === "POST" && url.pathname === "/admin/api/accounts/import-session") {
        if (typeof admin.importSession !== "function") {
          writeError(res, openAiHttpError(404, "Admin account import is not configured.", "invalid_request_error", "not_found"));
          return;
        }
        const body = await readJson(req);
        const accountId = String(body.accountId || "").trim();
        const session = String(body.session || "");
        const chatSessionId = String(body.chatSessionId || "").trim();
        const accessTier = typeof body.accessTier === "string" ? body.accessTier.trim().toLowerCase() : "";
        if (!session) {
          writeError(res, openAiHttpError(400, "请粘贴 Tabbit session / cookie。", "invalid_request_error", "invalid_admin_account_input"));
          return;
        }
        if (!ADMIN_ACCOUNT_ACCESS_TIERS.has(accessTier)) {
          writeError(res, openAiHttpError(400, "accessTier must be unknown, free, or pro.", "invalid_request_error", "invalid_admin_account_input"));
          return;
        }
        const importInput = {
          accountId,
          email: typeof body.email === "string" ? body.email.trim() : "",
          session,
          accessTier,
        };
        if (chatSessionId) importInput.chatSessionId = chatSessionId;
        const account = await admin.importSession(importInput);
        writeJson(res, 200, { account: redactAccountForDisplay(account), changed: true });
        return;
      }

      if (admin && req.method === "POST" && url.pathname === "/admin/api/accounts/status") {
        if (typeof admin.updateAccountStatus !== "function") {
          writeError(res, openAiHttpError(404, "Admin account status update is not configured.", "invalid_request_error", "not_found"));
          return;
        }
        const body = await readJson(req);
        const accountId = String(body.accountId || "").trim();
        const status = String(body.status || "").trim();
        if (!accountId || !ADMIN_ACCOUNT_STATUSES.has(status)) {
          writeError(res, openAiHttpError(400, "accountId and a supported status are required.", "invalid_request_error", "invalid_admin_account_input"));
          return;
        }
        const account = await admin.updateAccountStatus({ accountId, status });
        writeJson(res, 200, { account: redactAccountForDisplay(account), changed: true });
        return;
      }

      if (admin && req.method === "GET" && url.pathname === "/admin/api/key") {
        if (!isAdminBasicAuthorized(req, admin)) {
          writeError(res, openAiHttpError(401, "Missing or invalid admin credentials.", "authentication_error", "invalid_api_key"));
          return;
        }
        if (typeof admin.keyProvider !== "function") {
          writeError(res, openAiHttpError(404, "Admin key details are not configured.", "invalid_request_error", "not_found"));
          return;
        }
        writeJson(res, 200, sanitizeAdminKeyDetails(await admin.keyProvider()));
        return;
      }

      if (admin && req.method === "POST" && url.pathname === "/admin/api/key/rotate") {
        if (!isAdminBasicAuthorized(req, admin)) {
          writeError(res, openAiHttpError(401, "Missing or invalid admin credentials.", "authentication_error", "invalid_api_key"));
          return;
        }
        if (typeof admin.rotateGatewayKey !== "function") {
          writeError(res, openAiHttpError(404, "Admin key rotation is not configured.", "invalid_request_error", "not_found"));
          return;
        }
        await readJson(req);
        writeJson(res, 200, sanitizeAdminKeyRotation(await admin.rotateGatewayKey()));
        return;
      }

      if (url.pathname.startsWith("/v1/") && !isAuthorized(req, activeApiKey())) {
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
