import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FileSecretStore, SecretStoreError, resolveSecretRefPath } from "../src/secret-store.js";

async function tempStateDir() {
  return await mkdtemp(join(tmpdir(), "tabbit-secret-store-"));
}

test("resolveSecretRefPath keeps relative refs inside the state directory", async () => {
  const stateDir = await tempStateDir();
  const resolved = resolveSecretRefPath({ stateDir, ref: "secrets/acct_a.cookie" });

  assert.equal(resolved, join(stateDir, "secrets", "acct_a.cookie"));
});

test("FileSecretStore writes and reads exact secret text", async () => {
  const stateDir = await tempStateDir();
  const store = new FileSecretStore({ stateDir });

  await store.writeSecret("secrets/acct_a.cookie", "placeholder-cookie-value");

  assert.equal(await store.readSecret("secrets/acct_a.cookie"), "placeholder-cookie-value");
});

test("FileSecretStore returns null for missing secret refs", async () => {
  const stateDir = await tempStateDir();
  const store = new FileSecretStore({ stateDir });

  assert.equal(await store.readSecret("secrets/missing.cookie"), null);
});

test("resolveSecretRefPath rejects refs that escape or bypass the state directory", async () => {
  const stateDir = await tempStateDir();
  const invalidRefs = ["", "../outside.cookie", "secrets/../outside.cookie", "/outside.cookie", "C:/outside.cookie", "C:\\outside.cookie"];

  for (const ref of invalidRefs) {
    assert.throws(
      () => resolveSecretRefPath({ stateDir, ref }),
      (error) => {
        assert.equal(error instanceof SecretStoreError, true);
        assert.equal(error.code, "INVALID_SECRET_REF");
        return true;
      },
    );
  }
});
