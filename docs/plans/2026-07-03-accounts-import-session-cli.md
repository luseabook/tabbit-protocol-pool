# Accounts Import Session CLI

日期：2026-07-03

## 背景

真实 Tabbit 注册、登录和验证码 endpoint 尚未还原时，真实协议校准仍需要一个 active 账号。最小可行路径是导入用户本机已登录 Tabbit 的 cookie/session，把原始 session 写入本地 secret store，账号元数据只保存引用。

## 范围

- 新增 `tabbit-pool accounts import-session`。
- 支持 `--id`、`--email`、`--user-id`、`--access-tier`、`--cookie-jar-ref`。
- 支持四种 session 来源：`--cookie-header`、`--session`、`--cookie-file`、`--session-file`。
- 调用 `AccountProvisioner.importSession()` 保存 active 账号。
- stdout/stderr 不输出 raw cookie、session、token、验证码或 `cookieJarRef`。

## 非范围

- 不自动读取浏览器或 Tabbit 客户端 cookie 数据库。
- 不还原 Tabbit 注册/登录 endpoint。
- 不验证 session 是否仍有效；验证继续交给 `accounts probe` 和显式协议 env。

## TDD 清单

1. 先写 `accounts import-session --cookie-file --json` 测试，断言 secret store 写入原始 cookie、账号 store 保存 active 元数据、stdout 脱敏。
2. 先写 session 来源冲突测试，断言 exitCode=2，stderr 不泄露传入值。
3. RED：命令不存在时测试失败。
4. GREEN：实现最小 CLI handler、session source parser 和路由。

## 验收

- `node --test test/ops-cli.test.js` 通过。
- `npm test` 通过。
- README、M08、API/测试/接口参考和开发追踪同步。
