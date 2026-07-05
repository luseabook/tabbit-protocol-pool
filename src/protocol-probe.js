import fs from "node:fs/promises";
import path from "node:path";

import { protocolProbeAdvice, redactAccountForDisplay } from "./observability.js";
import { redactObject, redactSensitiveValue } from "./redact.js";

function nowIso(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return date.toISOString();
}

function sanitizeText(value) {
  if (value === null || value === undefined) return value;
  return redactSensitiveValue(value).replace(/\b\d{4,8}\b/g, "***");
}

function cleanOperation(value) {
  return String(value || "verifySession").trim() || "verifySession";
}

function safeName(value) {
  return String(value || "probe").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "probe";
}

function compactError(error = {}) {
  if (!error || typeof error !== "object") return null;
  return {
    ...(error.category ? { category: String(error.category) } : {}),
    ...(error.code ? { code: String(error.code) } : {}),
    ...(error.status ? { status: Number(error.status) } : {}),
    ...(error.message ? { message: sanitizeText(error.message) } : {}),
    ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
    ...(Number.isFinite(error.cooldownMs) ? { cooldownMs: error.cooldownMs } : {}),
  };
}

function protocolError(message, { category = "unknown", code = null, status = null } = {}) {
  return { message, category, ...(code ? { code } : {}), ...(status ? { status } : {}) };
}

function sideEffectConfirmationError() {
  return protocolError("Explicit confirmSideEffect:true is required for this auth probe operation.", {
    category: "invalid_request",
    code: "SIDE_EFFECT_CONFIRMATION_REQUIRED",
  });
}

function isAuthProbeOperation(operation) {
  return operation === "sendVerificationCode" || operation === "submitRegistrationOrLogin";
}

const USER_ID_HYDRATED_PROBE_METHODS = {
  refreshQuota: "refreshQuota",
  listRewardCardRecords: "listRewardCardRecords",
  listLotteryHitRecords: "listLotteryHitRecords",
  listBenefitCoupons: "listBenefitCoupons",
  participateResetCouponActivity: "participateResetCouponActivity",
  useResetCoupon: "useResetCoupon",
  participateActivity: "participateActivity",
  getAvailableLotteryChanceCount: "getAvailableLotteryChanceCount",
  drawLottery: "drawLottery",
};
const STREAM_EVIDENCE_MODES = new Set([
  "first_token_backpressure",
  "cancel_after_first_delta",
  "error_frame",
]);
const DEFAULT_STREAM_EVIDENCE_DELTAS = 2;
const MAX_STREAM_EVIDENCE_DELTAS = 5;
const REDACTED_MESSAGE_CONTENT_PLACEHOLDER = "<redacted-message-content>";

function nonEmptyInputValue(value) {
  if (typeof value === "string") return value.trim() ? value : null;
  return value === undefined || value === null || value === "" ? null : value;
}

function userIdFromProbeInput(input = {}) {
  return nonEmptyInputValue(input?.userId) || nonEmptyInputValue(input?.user_id) || null;
}

function userIdFromAccount(account = {}) {
  return nonEmptyInputValue(account?.userId) || nonEmptyInputValue(account?.user_id) || null;
}

function bodyWithUserId(body, userId) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !userId) return body;
  if (nonEmptyInputValue(body.user_id) || nonEmptyInputValue(body.userId)) return body;
  return { ...body, user_id: userId };
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function isAsyncIterable(value) {
  return value && typeof value[Symbol.asyncIterator] === "function";
}

function streamEvidenceInput(input = {}) {
  const evidence = input?.streamEvidence;
  if (!plainObject(evidence)) return null;
  const mode = String(evidence.mode || "").trim();
  if (!STREAM_EVIDENCE_MODES.has(mode)) return null;
  const maxDeltas = Number.isInteger(evidence.maxDeltas)
    ? evidence.maxDeltas
    : DEFAULT_STREAM_EVIDENCE_DELTAS;
  if (maxDeltas < 1 || maxDeltas > MAX_STREAM_EVIDENCE_DELTAS) return null;
  return { mode, maxDeltas };
}

function hasRealUpstreamStreamMarker(result = {}) {
  const evidence = result?.upstreamEvidence;
  return evidence?.source === "tabbit-live" && evidence.real === true && evidence.stream === true;
}

function mergeUpstreamEvidence(result, markers) {
  result.upstreamEvidence = {
    ...(plainObject(result.upstreamEvidence) ? result.upstreamEvidence : {}),
    ...markers,
  };
}

function streamEvidenceNotCapturedError() {
  return protocolError("stream evidence was requested but not captured", {
    category: "protocol_changed",
    code: "STREAM_EVIDENCE_NOT_CAPTURED",
  });
}

async function captureStreamEvidence(result, input = {}) {
  const capture = streamEvidenceInput(input);
  if (!capture) return null;
  if (!plainObject(result) || !hasRealUpstreamStreamMarker(result) || !isAsyncIterable(result.streamDeltas)) {
    return streamEvidenceNotCapturedError();
  }

  const iterator = result.streamDeltas[Symbol.asyncIterator]();
  let observedDeltas = 0;
  let streamDone = false;
  try {
    while (observedDeltas < capture.maxDeltas) {
      const next = await iterator.next();
      if (next.done) {
        streamDone = true;
        break;
      }
      observedDeltas += 1;
      if (capture.mode === "cancel_after_first_delta") {
        if (typeof iterator.return === "function") await iterator.return();
        streamDone = true;
        mergeUpstreamEvidence(result, { cancellation: true });
        return null;
      }
    }
  } catch (error) {
    if (capture.mode === "error_frame") {
      mergeUpstreamEvidence(result, { streamErrorFrame: true });
      return protocolError("upstream stream error frame observed", {
        category: error?.category || "protocol_changed",
        code: error?.code || "UPSTREAM_STREAM_ERROR_FRAME",
        status: error?.status,
      });
    }
    throw error;
  }
  if (!streamDone && observedDeltas >= capture.maxDeltas && typeof iterator.return === "function") {
    await iterator.return();
  }

  if (capture.mode === "first_token_backpressure" && observedDeltas >= 2) {
    mergeUpstreamEvidence(result, {
      backpressure: true,
      firstTokenFlush: true,
      delayedSecondChunk: true,
    });
    return null;
  }
  return streamEvidenceNotCapturedError();
}

export class ProtocolFixtureStoreError extends Error {
  constructor(message, { code = "FIXTURE_STORE_ERROR", exitCode = 1 } = {}) {
    super(message);
    this.name = "ProtocolFixtureStoreError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function isInsidePath(childPath, rootPath) {
  const relative = path.relative(rootPath, childPath);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function shouldRedactProbeText(key = "", parentKey = "") {
  if (/^(content|prompt|text|output|html_content|delta|payload|query|queries|arguments|arguments_delta)$/i.test(key)) return true;
  if (/^(streamDeltas|deltas)$/i.test(key)) return true;
  if (key === "data" && /^(attachments?|events?|frames?|messages?)$/i.test(parentKey)) return true;
  return false;
}

function shouldRedactProbePrimitive(key = "", parentKey = "") {
  if (shouldRedactProbeText(key, parentKey)) return true;
  if (/^(chatSessionId|chat_session_id|messageId|message_id|parentId|parent_id|requestMessageId|request_message_id|toolCallId|tool_call_id|parallelGroupId|parallel_group_id)$/i.test(key)) return true;
  if (/^(couponCode|coupon_code|couponNo|coupon_no|couponId|coupon_id)$/i.test(key)) return true;
  if (/^id$/i.test(key) && /^(contentBlocks|toolCalls|tool_calls)$/i.test(parentKey)) return true;
  if (/^(userId|user_id|uid|openId|open_id|unionId|union_id|nickname|displayName|display_name|avatar|avatar_url|phone|mobile|uuid|captcha|captchaToken|captcha_token|challenge|challenge_id|requestCode|request_code|verifyUrl|verify_url|ticket|randstr|validate|seccode|risk_token)$/i.test(key)) return true;
  if (/^(id|name)$/i.test(key) && /^(user|users|user_info|profile|member)$/i.test(parentKey)) return true;
  return false;
}

function isErrorCodeField(key = "", parentKey = "") {
  return /^code$/i.test(key) && /^error$/i.test(parentKey);
}

function deeplySanitize(value, key = "", parentKey = "") {
  if (Array.isArray(value)) return value.map((item) => deeplySanitize(item, key, parentKey));
  if (value && typeof value === "object") {
    if (shouldRedactProbeText(key, parentKey)) return "***";
    const output = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = deeplySanitize(childValue, childKey, key);
    }
    return output;
  }
  if ((typeof value === "string" || typeof value === "number") && isErrorCodeField(key, parentKey)) {
    return sanitizeText(value);
  }
  if ((typeof value === "string" || typeof value === "number") && shouldRedactProbePrimitive(key, parentKey)) {
    return "***";
  }
  if (typeof value === "string") {
    if (key === "data" && /^attachments?$/i.test(parentKey)) {
      return "***";
    }
    if (/^(apiKey|apikey|authorization|cookie|cookieHeader|cookieJar|cookieJarRef|cookieRef|password|secret|session|sessionToken|token|verification|code)$/i.test(key)) {
      return "***";
    }
    return sanitizeText(value);
  }
  return value;
}

function redactedPayload(value) {
  return deeplySanitize(redactObject(value));
}

function defaultAttachmentProbeInput() {
  return {
    filename: "probe.txt",
    mimeType: "text/plain",
    data: "base64-probe-payload",
  };
}

export function sanitizeProtocolProbeFixture(value) {
  if (Array.isArray(value) || !value || typeof value !== "object") {
    return redactedPayload(value);
  }
  const fixture = { ...value };
  if (fixture.account && typeof fixture.account === "object" && !Array.isArray(fixture.account)) {
    fixture.account = redactAccountForDisplay(fixture.account);
  }
  const sanitized = redactedPayload(fixture);
  if (Object.prototype.hasOwnProperty.call(fixture, "observedAt")) {
    sanitized.observedAt = String(fixture.observedAt);
  }
  return sanitized;
}

function fixtureSummary(fixture, ref) {
  return {
    ref,
    ...(fixture.observedAt ? { observedAt: String(fixture.observedAt) } : {}),
    ...(fixture.operation ? { operation: String(fixture.operation) } : {}),
    status: String(fixture.status || "unknown"),
    ...(fixture.accountId ? { accountId: String(fixture.accountId) } : {}),
    ...(fixture.advice?.category ? { adviceCategory: String(fixture.advice.category) } : {}),
  };
}

const LISTABLE_FIXTURE_KINDS = new Set([
  "protocol_probe",
  "session_recovery_strategy",
  "reset_coupon_consumption_evidence",
]);
const PROTOCOL_FIXTURE_REF_PREFIX = "fixtures/protocol-probes/";

export function buildProtocolProbeFixture({
  observedAt = nowIso(),
  accountId = null,
  operation = "verifySession",
  status = "unknown",
  account = null,
  input = null,
  result = null,
  error = null,
  advice = null,
} = {}) {
  const compactedError = compactError(error);
  const finalAdvice = advice || protocolProbeAdvice(compactedError || {});
  return {
    version: 1,
    kind: "protocol_probe",
    observedAt: typeof observedAt === "string" ? observedAt : nowIso(observedAt),
    operation: cleanOperation(operation),
    ...(accountId || account?.id ? { accountId: String(accountId || account.id) } : {}),
    status: String(status || "unknown"),
    ...(account ? { account: redactAccountForDisplay(account) } : {}),
    ...(input !== null && input !== undefined ? { input: redactedPayload(input) } : {}),
    ...(result !== null && result !== undefined ? { result: redactedPayload(result) } : {}),
    ...(compactedError ? { error: compactedError } : {}),
    advice: finalAdvice,
  };
}

export class FileProtocolFixtureStore {
  constructor({ stateDir, fixtureDir = null, fs: fsImpl = fs, now = () => Date.now(), idFactory = null } = {}) {
    if (!stateDir) throw new Error("stateDir is required");
    this.stateDir = stateDir;
    this.fixtureDir = fixtureDir ? path.resolve(fixtureDir) : null;
    this.fs = fsImpl;
    this.now = now;
    this.idFactory = idFactory;
  }

  refFor(fixture) {
    const id = this.idFactory
      ? this.idFactory(fixture)
      : [
        nowIso(this.now).replace(/[:.]/g, ""),
        safeName(fixture.accountId || "account"),
        safeName(fixture.operation || "probe"),
      ].join("-");
    return PROTOCOL_FIXTURE_REF_PREFIX + safeName(id) + ".json";
  }

  fixturesRoot() {
    return this.fixtureDir || path.resolve(this.stateDir, "fixtures", "protocol-probes");
  }

  resolveFixtureRef(ref) {
    const cleanRef = String(ref || "").trim().replaceAll("\\", "/");
    if (!cleanRef) {
      throw new ProtocolFixtureStoreError("fixture ref is required", {
        code: "FIXTURE_REF_REQUIRED",
        exitCode: 2,
      });
    }
    const root = this.fixturesRoot();
    const filePath = this.fixtureDir
      ? path.resolve(root, cleanRef.startsWith(PROTOCOL_FIXTURE_REF_PREFIX)
        ? cleanRef.slice(PROTOCOL_FIXTURE_REF_PREFIX.length)
        : cleanRef)
      : path.resolve(this.stateDir, cleanRef);
    if (!isInsidePath(filePath, root)) {
      throw new ProtocolFixtureStoreError("fixture ref must stay inside protocol probe fixtures", {
        code: "FIXTURE_REF_OUTSIDE_ROOT",
        exitCode: 2,
      });
    }
    if (this.fixtureDir && !cleanRef.startsWith(PROTOCOL_FIXTURE_REF_PREFIX)) {
      throw new ProtocolFixtureStoreError("fixture ref must stay inside protocol probe fixtures", {
        code: "FIXTURE_REF_OUTSIDE_ROOT",
        exitCode: 2,
      });
    }
    return {
      filePath,
      ref: PROTOCOL_FIXTURE_REF_PREFIX + path.relative(root, filePath).replaceAll("\\", "/"),
    };
  }

  async writeFixture(fixture) {
    const ref = this.refFor(fixture);
    const { filePath, ref: normalizedRef } = this.resolveFixtureRef(ref);
    await this.fs.mkdir(path.dirname(filePath), { recursive: true });
    await this.fs.writeFile(filePath, JSON.stringify(sanitizeProtocolProbeFixture(fixture), null, 2) + "\n", "utf8");
    return normalizedRef;
  }

  async readFixture(ref) {
    const { filePath } = this.resolveFixtureRef(ref);
    let text;
    try {
      text = await this.fs.readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new ProtocolFixtureStoreError("fixture not found: " + sanitizeText(ref), {
          code: "FIXTURE_NOT_FOUND",
          exitCode: 2,
        });
      }
      throw error;
    }

    try {
      return sanitizeProtocolProbeFixture(JSON.parse(text));
    } catch (error) {
      throw new ProtocolFixtureStoreError("invalid fixture JSON: " + sanitizeText(ref), {
        code: "FIXTURE_INVALID_JSON",
        exitCode: 1,
      });
    }
  }

  async listFixtures() {
    const root = this.fixturesRoot();
    let entries;
    try {
      entries = await this.fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }

    const summaries = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const ref = PROTOCOL_FIXTURE_REF_PREFIX + entry.name;
      let fixture;
      try {
        fixture = await this.readFixture(ref);
      } catch {
        continue;
      }
      if (!LISTABLE_FIXTURE_KINDS.has(fixture?.kind)) continue;
      summaries.push(fixtureSummary(fixture, ref));
    }
    return summaries.sort((left, right) => {
      const byObservedAt = String(right.observedAt || "").localeCompare(String(left.observedAt || ""));
      return byObservedAt || left.ref.localeCompare(right.ref);
    });
  }
}

export class ProtocolProbeRunner {
  constructor({
    accountStore,
    secretStore,
    protocolClientFactory = null,
    fixtureStore = null,
    now = () => Date.now(),
  } = {}) {
    if (!accountStore || typeof accountStore.loadAccounts !== "function") {
      throw new Error("accountStore with loadAccounts() is required");
    }
    this.accountStore = accountStore;
    this.secretStore = secretStore || {};
    this.protocolClientFactory = protocolClientFactory;
    this.fixtureStore = fixtureStore;
    this.now = now;
  }

  async loadAccount(accountId) {
    const accounts = await this.accountStore.loadAccounts();
    return (Array.isArray(accounts) ? accounts : []).find((account) => account?.id === accountId) || null;
  }

  async finalize({ account, accountId, operation, input, status, result = null, error = null, writeFixture = false }) {
    const fixture = buildProtocolProbeFixture({
      observedAt: nowIso(this.now),
      accountId,
      operation,
      status,
      account,
      input,
      result,
      error,
    });
    const output = {
      status,
      account: account ? redactAccountForDisplay(account) : null,
      fixture,
      advice: fixture.advice,
    };
    if (writeFixture && this.fixtureStore && typeof this.fixtureStore.writeFixture === "function") {
      output.fixtureRef = await this.fixtureStore.writeFixture(fixture);
    }
    return output;
  }

  missingOperation(account, accountId, operation, input, writeFixture) {
    return this.finalize({
      account,
      accountId,
      operation,
      input,
      status: "skipped",
      error: protocolError("protocol operation is not configured: " + operation, {
        category: "protocol_missing",
        code: "PROTOCOL_OPERATION_MISSING",
      }),
      writeFixture,
    });
  }

  async hydrateUserIdForProbe(client, operation, runtimeAccount, session, input = {}) {
    const existing = userIdFromProbeInput(input) || userIdFromAccount(runtimeAccount);
    const targetMethod = USER_ID_HYDRATED_PROBE_METHODS[operation];
    if (existing || !targetMethod || typeof client[targetMethod] !== "function" || typeof client.verifySession !== "function") {
      return existing;
    }
    let result;
    try {
      result = await client.verifySession({ account: runtimeAccount, session });
    } catch {
      return null;
    }
    const hydrated = result?.ok === true ? userIdFromAccount(result) : null;
    if (hydrated) runtimeAccount.userId = hydrated;
    return hydrated;
  }

  async dispatch(client, operation, runtimeAccount, session, input) {
    if (operation === "verifySession") {
      if (typeof client.verifySession !== "function") return { missing: true };
      return { result: await client.verifySession({ account: runtimeAccount, session, input }) };
    }
    if (operation === "sendVerificationCode") {
      if (input?.confirmSideEffect !== true) return { error: sideEffectConfirmationError() };
      if (typeof client.sendVerificationCode !== "function") return { missing: true };
      return {
        result: await client.sendVerificationCode({
          account: runtimeAccount,
          email: input?.email,
          body: input?.body,
          input,
          confirmSideEffect: input?.confirmSideEffect,
        }),
      };
    }
    if (operation === "submitRegistrationOrLogin") {
      if (input?.confirmSideEffect !== true) return { error: sideEffectConfirmationError() };
      if (typeof client.submitRegistrationOrLogin !== "function") return { missing: true };
      return {
        result: await client.submitRegistrationOrLogin({
          account: runtimeAccount,
          email: input?.email,
          code: input?.code,
          body: input?.body,
          input,
          confirmSideEffect: input?.confirmSideEffect,
        }),
      };
    }
    if (operation === "sendMessage") {
      if (typeof client.sendMessage !== "function") return { missing: true };
      return {
        result: await client.sendMessage({
          model: input?.model || "tabbit/priority",
          messages: input?.messages || [{ role: "user", content: REDACTED_MESSAGE_CONTENT_PLACEHOLDER }],
          stream: false,
          ...input,
          account: runtimeAccount,
        }),
      };
    }
    if (operation === "listModels") {
      if (typeof client.listModels !== "function") return { missing: true };
      return { result: await client.listModels({ force: true, ...input }) };
    }
    const hydratedUserId = await this.hydrateUserIdForProbe(client, operation, runtimeAccount, session, input);
    const userIdForProbe = hydratedUserId || undefined;
    if (operation === "refreshQuota") {
      if (typeof client.refreshQuota !== "function") return { missing: true };
      return {
        result: await client.refreshQuota({
          account: runtimeAccount,
          ...(userIdForProbe ? { userId: userIdForProbe } : {}),
        }),
      };
    }
    if (operation === "getLotteryExplorationMe") {
      if (typeof client.getLotteryExplorationMe !== "function") return { missing: true };
      return { result: await client.getLotteryExplorationMe({ account: runtimeAccount }) };
    }
    if (operation === "getPlacementResources") {
      if (typeof client.getPlacementResources !== "function") return { missing: true };
      return {
        result: await client.getPlacementResources({
          account: runtimeAccount,
          placementCode: input?.placementCode,
          clientVersion: input?.clientVersion,
        }),
      };
    }
    if (operation === "getNewbieExplorationMe") {
      if (typeof client.getNewbieExplorationMe !== "function") return { missing: true };
      return {
        result: await client.getNewbieExplorationMe({
          account: runtimeAccount,
          viewMode: input?.viewMode,
          includeCompletions: input?.includeCompletions,
          includeRewards: input?.includeRewards,
          intentTaskCode: input?.intentTaskCode,
          intentCompletionEventType: input?.intentCompletionEventType,
        }),
      };
    }
    if (operation === "listRewardCardRecords") {
      if (typeof client.listRewardCardRecords !== "function") return { missing: true };
      return {
        result: await client.listRewardCardRecords({
          account: runtimeAccount,
          userId: userIdForProbe,
          offset: input?.offset,
          limit: input?.limit,
          order: input?.order,
          rewardPackageId: input?.rewardPackageId,
          awardStatus: input?.awardStatus,
        }),
      };
    }
    if (operation === "listLotteryHitRecords") {
      if (typeof client.listLotteryHitRecords !== "function") return { missing: true };
      return {
        result: await client.listLotteryHitRecords({
          account: runtimeAccount,
          userId: userIdForProbe,
          offset: input?.offset,
          limit: input?.limit,
          mainPoolId: input?.mainPoolId,
        }),
      };
    }
    if (operation === "getDailySignInStatus") {
      if (typeof client.getDailySignInStatus !== "function") return { missing: true };
      return {
        result: await client.getDailySignInStatus({
          account: runtimeAccount,
          sceneCodes: input?.sceneCodes,
        }),
      };
    }
    if (operation === "dailySignIn") {
      if (typeof client.dailySignIn !== "function") return { missing: true };
      return {
        result: await client.dailySignIn({
          account: runtimeAccount,
          requestNo: input?.requestNo,
          sceneCodes: input?.sceneCodes,
          confirmSideEffect: input?.confirmSideEffect,
        }),
      };
    }
    if (operation === "listBenefitCoupons") {
      if (typeof client.listBenefitCoupons !== "function") return { missing: true };
      return {
        result: await client.listBenefitCoupons({
          account: runtimeAccount,
          userId: userIdForProbe,
          couponType: input?.couponType,
          offset: input?.offset,
          limit: input?.limit,
          status: input?.status,
        }),
      };
    }
    if (operation === "participateResetCouponActivity") {
      if (typeof client.participateResetCouponActivity !== "function") return { missing: true };
      return {
        result: await client.participateResetCouponActivity({
          account: runtimeAccount,
          userId: userIdForProbe,
          requestNo: input?.requestNo,
          confirmSideEffect: input?.confirmSideEffect,
        }),
      };
    }
    if (operation === "useResetCoupon") {
      if (typeof client.useResetCoupon !== "function") return { missing: true };
      return {
        result: await client.useResetCoupon({
          account: runtimeAccount,
          userId: userIdForProbe,
          couponCode: input?.couponCode,
          couponType: input?.couponType,
          requestNo: input?.requestNo,
          confirmSideEffect: input?.confirmSideEffect,
        }),
      };
    }
    if (operation === "participateActivity") {
      if (typeof client.participateActivity !== "function") return { missing: true };
      return {
        result: await client.participateActivity({
          account: runtimeAccount,
          body: bodyWithUserId(input?.body, userIdForProbe),
          confirmSideEffect: input?.confirmSideEffect,
        }),
      };
    }
    if (operation === "getUsageResetCouponSku") {
      if (typeof client.getUsageResetCouponSku !== "function") return { missing: true };
      return { result: await client.getUsageResetCouponSku({ account: runtimeAccount }) };
    }
    if (operation === "getAvailableLotteryChanceCount") {
      if (typeof client.getAvailableLotteryChanceCount !== "function") return { missing: true };
      return {
        result: await client.getAvailableLotteryChanceCount({
          account: runtimeAccount,
          userId: userIdForProbe,
          activityId: input?.activityId,
        }),
      };
    }
    if (operation === "getActiveMainPools") {
      if (typeof client.getActiveMainPools !== "function") return { missing: true };
      return {
        result: await client.getActiveMainPools({
          account: runtimeAccount,
          activityId: input?.activityId,
        }),
      };
    }
    if (operation === "listLotteryChanceRecords") {
      if (typeof client.listLotteryChanceRecords !== "function") return { missing: true };
      return {
        result: await client.listLotteryChanceRecords({
          account: runtimeAccount,
          activityId: input?.activityId,
          offset: input?.offset,
          limit: input?.limit,
        }),
      };
    }
    if (operation === "drawLottery") {
      if (typeof client.drawLottery !== "function") return { missing: true };
      return {
        result: await client.drawLottery({
          account: runtimeAccount,
          body: bodyWithUserId(input?.body, userIdForProbe),
          confirmSideEffect: input?.confirmSideEffect,
        }),
      };
    }
    if (operation === "uploadAttachment") {
      if (typeof client.uploadAttachment !== "function") return { missing: true };
      const uploadInput = input && typeof input === "object" && !Array.isArray(input) ? input : {};
      return {
        result: await client.uploadAttachment({
          ...uploadInput,
          attachment: uploadInput.attachment || defaultAttachmentProbeInput(),
          account: runtimeAccount,
        }),
      };
    }
    return {
      error: protocolError("unsupported protocol probe operation: " + operation, {
        category: "invalid_request",
        code: "UNSUPPORTED_OPERATION",
      }),
    };
  }

  async probeAccount({ accountId, operation = "verifySession", input = {}, writeFixture = false } = {}) {
    const cleanAccountId = String(accountId || "").trim();
    const cleanOp = cleanOperation(operation);
    const probeInput = input || {};
    const account = cleanAccountId ? await this.loadAccount(cleanAccountId) : null;
    if (!account) {
      return await this.finalize({
        account: null,
        accountId: cleanAccountId || null,
        operation: cleanOp,
        input,
        status: "failed",
        error: protocolError("account not found: " + (cleanAccountId || "<missing>"), {
          category: "account_not_found",
          code: "ACCOUNT_NOT_FOUND",
        }),
        writeFixture,
      });
    }

    if (isAuthProbeOperation(cleanOp) && probeInput?.confirmSideEffect !== true) {
      return await this.finalize({
        account,
        accountId: cleanAccountId,
        operation: cleanOp,
        input,
        status: "failed",
        error: sideEffectConfirmationError(),
        writeFixture,
      });
    }

    const session = account.cookieJarRef && typeof this.secretStore.readSecret === "function"
      ? await this.secretStore.readSecret(account.cookieJarRef)
      : null;
    if (!session && !isAuthProbeOperation(cleanOp)) {
      return await this.finalize({
        account,
        accountId: cleanAccountId,
        operation: cleanOp,
        input,
        status: "failed",
        error: protocolError("stored session material is missing", {
          category: "session_missing",
          code: "SESSION_MISSING",
        }),
        writeFixture,
      });
    }

    if (typeof this.protocolClientFactory !== "function") {
      return await this.missingOperation(account, cleanAccountId, cleanOp, input, writeFixture);
    }

    const runtimeAccount = session ? { ...account, cookieHeader: account.cookieHeader || session } : { ...account };
    const client = this.protocolClientFactory(runtimeAccount);
    try {
      const dispatched = await this.dispatch(client || {}, cleanOp, runtimeAccount, session, probeInput);
      if (dispatched.missing) return await this.missingOperation(account, cleanAccountId, cleanOp, input, writeFixture);
      if (dispatched.error) {
        return await this.finalize({ account, accountId: cleanAccountId, operation: cleanOp, input, status: "failed", error: dispatched.error, writeFixture });
      }
      const result = dispatched.result;
      const streamEvidenceError = cleanOp === "sendMessage"
        ? await captureStreamEvidence(result, probeInput)
        : null;
      if (streamEvidenceError) {
        return await this.finalize({
          account,
          accountId: cleanAccountId,
          operation: cleanOp,
          input,
          status: "failed",
          result,
          error: streamEvidenceError,
          writeFixture,
        });
      }
      if (result?.ok === false) {
        return await this.finalize({
          account,
          accountId: cleanAccountId,
          operation: cleanOp,
          input,
          status: "failed",
          result,
          error: protocolError(result.message || "protocol probe failed", {
            category: result.category || "protocol_changed",
            code: result.code || "PROBE_FAILED",
            status: result.status,
          }),
          writeFixture,
        });
      }
      return await this.finalize({ account, accountId: cleanAccountId, operation: cleanOp, input, status: "success", result, writeFixture });
    } catch (error) {
      return await this.finalize({
        account,
        accountId: cleanAccountId,
        operation: cleanOp,
        input,
        status: "failed",
        error: protocolError(error?.message || String(error), {
          category: error?.category || "unknown",
          code: error?.code || "PROBE_ERROR",
          status: error?.status,
        }),
        writeFixture,
      });
    }
  }
}
