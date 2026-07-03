import fs from "node:fs/promises";
import path from "node:path";

export class SecretStoreError extends Error {
  constructor(message, { code = "SECRET_STORE_ERROR", cause = null } = {}) {
    super(message);
    this.name = "SecretStoreError";
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function isNotFound(error) {
  return error?.code === "ENOENT";
}

function invalidSecretRef(ref) {
  const value = String(ref || "").trim();
  if (!value) return true;
  if (path.isAbsolute(value)) return true;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
  return value.split(/[\\/]+/).includes("..");
}

export function resolveSecretRefPath({ stateDir, ref } = {}) {
  if (!stateDir) throw new SecretStoreError("stateDir is required", { code: "MISSING_STATE_DIR" });
  if (invalidSecretRef(ref)) throw new SecretStoreError("secret ref must be a non-empty relative path inside stateDir", { code: "INVALID_SECRET_REF" });

  const root = path.resolve(stateDir);
  const target = path.resolve(root, String(ref));
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new SecretStoreError("secret ref must resolve inside stateDir", { code: "INVALID_SECRET_REF" });
  }
  return target;
}

export class FileSecretStore {
  constructor({ stateDir, fs: fsImpl = fs } = {}) {
    if (!stateDir) throw new SecretStoreError("stateDir is required", { code: "MISSING_STATE_DIR" });
    this.stateDir = stateDir;
    this.fs = fsImpl;
  }

  resolve(ref) {
    return resolveSecretRefPath({ stateDir: this.stateDir, ref });
  }

  async readSecret(ref) {
    try {
      return await this.fs.readFile(this.resolve(ref), "utf8");
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async writeSecret(ref, value) {
    const filePath = this.resolve(ref);
    await this.fs.mkdir(path.dirname(filePath), { recursive: true });
    await this.fs.writeFile(filePath, String(value), "utf8");
    return filePath;
  }
}
