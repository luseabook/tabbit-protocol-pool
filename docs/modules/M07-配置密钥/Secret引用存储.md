# Secret 引用存储

本文件记录 M07 当前已实现的文件型 secret 引用层。账号 JSON 只保存 `cookieJarRef` 这类引用；运行时由 `FileSecretStore` 根据引用读取本地 secret，并由 gateway 在请求前注入到临时账号对象。

## 定位

~~~text
accounts.json
  └─ cookieJarRef: "secrets/acct_a.cookie"
        ↓
FileSecretStore(stateDir)
        ↓
hydrateAccountSecrets()
        ↓
PooledRequestRunner / ProtocolTabbitClient runtime account
~~~

`FileSecretStore` 是当前阶段的本地文件实现，用来打通“元数据不落 secret”和“协议客户端需要 cookie”的运行链路。后续可以在同一接口后替换为系统密钥链或加密文件。

## 路径规则

公开函数：

~~~ts
resolveSecretRefPath({ stateDir, ref }): string
~~~

约束：

- `stateDir` 必填。
- `ref` 必须是非空相对路径。
- 拒绝绝对路径。
- 拒绝 `..` 路径段。
- 拒绝 Windows drive-letter 形式。
- 最终 resolved path 必须位于 `stateDir` 内。

非法引用会抛出 `SecretStoreError(INVALID_SECRET_REF)`。

## FileSecretStore

~~~ts
class FileSecretStore {
  constructor({ stateDir, fs? });
  resolve(ref): string;
  readSecret(ref): Promise<string | null>;
  writeSecret(ref, value): Promise<string>;
}
~~~

| 方法 | 行为 |
|---|---|
| `resolve(ref)` | 校验并返回 stateDir 内的绝对路径。 |
| `readSecret(ref)` | 读取 UTF-8 secret 文本；文件不存在时返回 `null`。 |
| `writeSecret(ref, value)` | 创建父目录并写入 UTF-8 文本，返回写入路径。 |

当前实现不把 secret 写入 `accounts.json`，也不会在 `JsonAccountStore.saveAccounts()` 中保留直接 `cookie` / `cookieHeader` 字段。

## Gateway hydrate 规则

`createProtocolPoolGateway()` 默认创建：

~~~js
const secretStore = new FileSecretStore({ stateDir: config.stateDir });
~~~

并把 protocol client factory 包装为 secret-hydrating factory。每次 `sendMessage()` 前：

1. 复制账号对象，不修改 account pool 内部状态。
2. 如果账号已经有 `cookie` 或 `cookieHeader`，保持原样。
3. 如果账号只有 `cookieJarRef`，调用 `secretStore.readSecret(cookieJarRef)`。
4. 读取成功时只把 secret 放入运行时账号对象的 `cookieHeader`。
5. 请求完成后的 `StoredAccountPool.persist()` 仍会通过 `JsonAccountStore` 剥离直接 secret 字段。

可以通过 `createProtocolPoolGateway({ hydrateSecrets: false })` 关闭默认 hydrate wrapper，或用 `secretStore` 注入自定义实现。

## How to：为账号添加 cookie 引用

1. 在账号元数据中只保存引用：

   ~~~json
   {
     "id": "acct_a",
     "status": "active",
     "cookieJarRef": "secrets/acct_a.cookie"
   }
   ~~~

2. 把本地 secret 文本写到状态目录下对应位置。测试和文档中使用占位值：

   ~~~powershell
   New-Item -ItemType Directory -Force "$env:TABBIT_POOL_STATE_DIR\secrets"
   Set-Content -Encoding UTF8 "$env:TABBIT_POOL_STATE_DIR\secrets\acct_a.cookie" "placeholder-cookie-value"
   ~~~

3. 启动 gateway。请求链路会在运行时读取引用，并传给协议客户端。

## 测试契约

- `test/secret-store.test.js` 覆盖相对路径解析、读写、缺失返回 `null`、非法 ref 拒绝。
- `test/protocol-pool-gateway.test.js` 覆盖 `cookieJarRef` hydrate 以及 raw cookie 不写回 `accounts.json`。

## 相关文档

- [M07-配置密钥](./_M07-配置密钥.md)
- [账号元数据持久化](../M02-账号池调度/账号元数据持久化.md)
- [启动工厂](../M06-兼容网关/启动工厂.md)
- [实现接口参考](../../09-实现接口参考.md#secret-store-接口)
