import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  AccountProvisioner,
  AccountProvisionerError,
  AnthropicCompat,
  BenefitsMaintainer,
  BenefitsMaintainerError,
  FileProtocolFixtureStore,
  FileSecretStore,
  ProtocolFixtureStoreError,
  JsonAccountStore,
  ProtocolProbeRunner,
  SecretStoreError,
  StoredAccountPool,
  YYDSMailProvider,
  anthropicErrorForCategory,
  anthropicMessageToSseEvents,
  buildAnthropicMessageResponse,
  buildCalibrationReadinessSnapshot,
  buildHealthSnapshot,
  buildProtocolProbeFixture,
  buildProtocolFixtureAudit,
  classifyForbiddenSignal,
  sanitizeProtocolProbeFixture,
  chatCompletionToSseEvents,
  closeServer,
  createGatewayHealthProvider,
  createDefaultProtocolClientFactory,
  createProtocolPoolGateway,
  createProtocolPoolCliDependencies,
  createProtocolPoolServer,
  createSecretHydratingProtocolClientFactory,
  extractSessionSecret,
  formatMaintenanceActionLog,
  hydrateAccountSecrets,
  listen,
  loadConfig,
  normalizeAnthropicMessagesRequest,
  normalizeQuotaState,
  protocolProbeAdvice,
  redactAccountForDisplay,
  redactAccountsForDisplay,
  runProtocolPoolCli,
  redactSensitiveValue,
  resolveSecretRefPath,
  responsesToSseEvents,
  sseData,
  summarizeAccounts,
  writeSse,
} from "../src/index.js";

test("package entry exposes foundation APIs", () => {
  assert.equal(typeof loadConfig, "function");
  assert.equal(typeof redactSensitiveValue, "function");
  assert.equal(typeof YYDSMailProvider, "function");
  assert.equal(typeof AccountProvisioner, "function");
  assert.equal(typeof AccountProvisionerError, "function");
  assert.equal(typeof extractSessionSecret, "function");
  assert.equal(typeof summarizeAccounts, "function");
  assert.equal(typeof redactAccountForDisplay, "function");
  assert.equal(typeof redactAccountsForDisplay, "function");
  assert.equal(typeof buildHealthSnapshot, "function");
  assert.equal(typeof buildCalibrationReadinessSnapshot, "function");
  assert.equal(typeof formatMaintenanceActionLog, "function");
  assert.equal(typeof protocolProbeAdvice, "function");
  assert.equal(typeof classifyForbiddenSignal, "function");
  assert.equal(typeof createGatewayHealthProvider, "function");
  assert.equal(typeof buildProtocolProbeFixture, "function");
  assert.equal(typeof buildProtocolFixtureAudit, "function");
  assert.equal(typeof ProtocolProbeRunner, "function");
  assert.equal(typeof FileProtocolFixtureStore, "function");
  assert.equal(typeof ProtocolFixtureStoreError, "function");
  assert.equal(typeof sanitizeProtocolProbeFixture, "function");
  assert.equal(typeof createProtocolPoolCliDependencies, "function");
  assert.equal(typeof runProtocolPoolCli, "function");
  assert.equal(typeof AnthropicCompat, "function");
  assert.equal(typeof BenefitsMaintainer, "function");
  assert.equal(typeof BenefitsMaintainerError, "function");
  assert.equal(typeof normalizeAnthropicMessagesRequest, "function");
  assert.equal(typeof normalizeQuotaState, "function");
  assert.equal(typeof buildAnthropicMessageResponse, "function");
  assert.equal(typeof anthropicErrorForCategory, "function");
  assert.equal(typeof anthropicMessageToSseEvents, "function");
  assert.equal(typeof createProtocolPoolServer, "function");
  assert.equal(typeof sseData, "function");
  assert.equal(typeof writeSse, "function");
  assert.equal(typeof chatCompletionToSseEvents, "function");
  assert.equal(typeof responsesToSseEvents, "function");
  assert.equal(typeof createProtocolPoolGateway, "function");
  assert.equal(typeof createDefaultProtocolClientFactory, "function");
  assert.equal(typeof createSecretHydratingProtocolClientFactory, "function");
  assert.equal(typeof hydrateAccountSecrets, "function");
  assert.equal(typeof FileSecretStore, "function");
  assert.equal(typeof SecretStoreError, "function");
  assert.equal(typeof resolveSecretRefPath, "function");
  assert.equal(typeof listen, "function");
  assert.equal(typeof closeServer, "function");
  assert.equal(typeof JsonAccountStore, "function");
  assert.equal(typeof StoredAccountPool, "function");
});


test("package metadata exposes the ops CLI executable", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.deepEqual(packageJson.bin, {
    "tabbit-pool": "./bin/tabbit-pool.js",
  });

  const executable = await readFile(new URL("../bin/tabbit-pool.js", import.meta.url), "utf8");
  assert.match(executable, /^#!\/usr\/bin\/env node/);
  assert.match(executable, /runProtocolPoolCli/);
});
