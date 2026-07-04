import { spawnSync } from "node:child_process";

const trackedTests = [
  "test/account-pool.test.js",
  "test/account-provisioner.test.js",
  "test/account-store.test.js",
  "test/anthropic-compat.test.js",
  "test/benefits-maintainer.test.js",
  "test/config.test.js",
  "test/http-server.test.js",
  "test/local-tool-loop-runner.test.js",
  "test/observability.test.js",
  "test/openai-compat.test.js",
  "test/ops-cli.test.js",
  "test/pooled-request-runner.test.js",
  "test/protocol-pool-gateway.test.js",
  "test/protocol-probe.test.js",
  "test/protocol-tabbit-client.test.js",
  "test/redact.test.js",
  "test/secret-store.test.js",
  "test/smoke.test.js",
  "test/yyds-mail-provider.test.js",
];

const result = spawnSync(process.execPath, ["--test", ...trackedTests], {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(typeof result.status === "number" ? result.status : 1);
