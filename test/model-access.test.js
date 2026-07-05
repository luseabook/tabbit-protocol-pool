import test from "node:test";
import assert from "node:assert/strict";

import { modelAccessRequiredTier, modelNameRequiredTier } from "../src/model-access.js";

test("premium-only catalog metadata requires the highest visible Pro account tier", () => {
  assert.equal(modelAccessRequiredTier("premium_only"), "pro");
  assert.equal(modelAccessRequiredTier("pro"), "pro");
  assert.equal(modelAccessRequiredTier("free_metered"), null);
});

test("Claude Opus model names require Pro when catalog metadata is unavailable", () => {
  assert.equal(modelNameRequiredTier("Claude-Opus-4.8"), "pro");
  assert.equal(modelNameRequiredTier("tabbit/Claude-Opus-4.8"), "pro");
  assert.equal(modelNameRequiredTier("Claude-Sonnet-5"), null);
});
