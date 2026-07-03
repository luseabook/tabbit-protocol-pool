# M03-YYDS邮箱接码

## 定位

YYDSMailProvider 封装 YYDS Mail/215 邮箱 API，用于创建临时 inbox、轮询邮件、读取验证码。它是账号注册初始化的前置模块。

## 已验证公共摘要

YYDS Mail `llms.txt` 公共摘要说明：

- Base URL：`https://maliapi.215.im/v1`。
- API key 认证：`X-API-Key: AC-xxxxxx`。
- 临时 inbox 支持 `POST /v1/accounts`。
- 消息读取支持 `GET /v1/messages?address=xxx`、`GET /v1/messages/{id}?address=xxx`、`GET /v1/sources/{id}?address=xxx`。
- 标准错误 envelope：`{ success: false, error, errorCode }`。
- `429` 响应包含 `Retry-After`。

## 公开能力

| 能力 | 方法草案 |
|---|---|
| 创建 inbox | `createInbox(input)` |
| 轮询邮件 | `listMessages(address)` / `waitForMessage(input)` |
| 读取详情 | `getMessage(id, address)` |
| 读取源码 | `getSource(id, address)` |
| 提取验证码 | `extractVerificationCode(message)` |

## 子文档

- [创建临时邮箱](创建临时邮箱.md)
- [轮询邮件](轮询邮件.md)
- [提取验证码](提取验证码.md)

## 安全约束

- `YYDS_MAIL_API_KEY` 只从环境变量或本地 secret store 读取。
- 日志中邮箱 localPart 默认脱敏。
- 邮件正文和 raw source 不能写入普通日志。
- 测试 fixture 必须替换验证码、邮箱地址和 token。
