# M01-Tabbit协议客户端

## 定位

ProtocolTabbitClient 是“脱离浏览器 UI”的核心模块。它负责把账号 session/cookie、签名 key、模型目录和消息发送协议封装成稳定的 Node API。

现有 Tabbit2API 通过 Playwright 捕获页面模块并发送消息；本模块的目标是把这条链路下沉为 HTTP/流式协议调用。

## 公开能力

| 能力 | 方法草案 | 说明 |
|---|---|---|
| 获取 sign key | `getSignKey(account)` | 拉取并缓存签名材料 |
| 生成签名头 | `signRequest(input)` | 输出 `x-timestamp`、`x-nonce`、`x-signature` |
| 同步模型目录 | `listModels(account?)` | 映射 Tabbit 模型能力 |
| 验证会话 | `verifySession(input)` | 已校准 `GET /api/v0/user/base-info`；默认仍不猜 endpoint，需显式配置路径 |
| 发送消息 | `sendMessage(input)` | 支持完整文本响应；显式 `sendPath` 返回 SSE/NDJSON 时可聚合解析文本 delta、buffered OpenAI stream tool_calls 与 buffered Anthropic input_json_delta |
| 上传附件 | `uploadAttachment(input)` | 显式 `attachmentUploadPath` 时保留签名 POST 骨架；同时配置 `attachmentCompleteUploadPath` 时走真实 COS 三步上传，真实发送分支可自动上传 raw/base64 附件后引用 |
| 查询额度 | `refreshQuota(input)` | 已校准 `GET /api/commerce/quota/v1/usage?user_id=...`；显式 `quotaUsagePath` 时可用 Cookie + `unique-uuid` 查询 usage 百分比 |
| 查询权益状态/资源 | `getLotteryExplorationMe()` / `getNewbieExplorationMe()` / `getPlacementResources()` / `listRewardCardRecords()` / `listLotteryHitRecords()` | 已校准只读 `/api/commerce` GET 探针；不执行领取、签到、抽奖或用券 |
| 错误分类 | `classifyProtocolError(error)` | 供账号池更新状态 |

## 输入与输出

~~~ts
type ProtocolTabbitClientOptions = {
  baseUrl?: string;
  signKeyPath?: string;
  modelCatalogPath?: string;
  modelCatalogScene?: string;
  sendPath?: string | null;
  attachmentUploadPath?: string | null;
  attachmentCompleteUploadPath?: string | null;
  quotaUsagePath?: string | null;
  activityLotteryPath?: string | null;
  newbieExplorationPath?: string | null;
  placementResourcesPath?: string | null;
  rewardCardRecordsPath?: string | null;
  lotteryHitRecordsPath?: string | null;
  sessionVerifyPath?: string | null;
  sessionVerifyMethod?: string;
  reqCtx?: string | null;
  defaultChatSessionId?: string | null;
  fetch?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
  signature?: () => string;
  uniqueUuid?: () => string;
  signKeyTtlMs?: number;
  modelCatalogTtlMs?: number;
};

type VerifySessionInput = {
  account?: { cookie?: string; cookieHeader?: string };
  session?: string | null;
};

type VerifySessionResult = {
  ok: true;
  userId?: string;
  accessTier?: string;
  raw: unknown;
} | {
  ok: false;
  category: string;
  code?: string | null;
  message: string;
  httpStatus: number | null;
  accountStatus: "login_expired" | "suspect";
  retryable: boolean;
  cooldownMs: number;
};

type SendMessageInput = {
  account: Account;
  model: string;
  messages: Array<Record<string, unknown>>;
  attachments?: unknown[];
  stream?: boolean;
  requestId?: string;
  chatSessionId?: string;
  content?: string;
  references?: unknown[];
  metadatas?: Record<string, unknown> | null;
};

type SendMessageResult = {
  ok: true;
  contentBlocks: Array<{ type: "text"; text: string }>;
  selectedModel: string;
  usageEstimate?: unknown;
} | {
  ok: false;
  error: ProtocolError;
};

type UploadAttachmentInput = {
  account?: { cookie?: string; cookieHeader?: string };
  attachment: {
    filename?: string;
    mimeType?: string;
    data?: string;
    [key: string]: unknown;
  };
};

type UploadAttachmentResult = {
  ok: true;
  attachment: {
    id: string;
    name: string | null;
    mimeType: string | null;
    size: number | string | null;
    url?: string;
  };
  raw: unknown;
} | {
  ok: false;
  error: ProtocolError;
};

type RefreshQuotaInput = {
  account?: { userId?: string; user_id?: string; cookie?: string; cookieHeader?: string };
  userId?: string | null;
};

type RefreshQuotaResult = {
  ok: true;
  source: "tabbit-quota-usage";
  accessTier?: string;
  resetCouponCount?: number;
  quotaState: Array<{
    model: "tabbit/priority";
    remaining: null;
    limit: null;
    unit: "usage_percentage";
    resetAt: string | null;
    exhausted: boolean;
    source: "tabbit-quota-usage";
    usagePercentage?: number;
  }>;
  raw: unknown;
};

type GetNewbieExplorationMeInput = {
  account?: { cookie?: string; cookieHeader?: string };
  viewMode?: "event_gate" | "float_collapsed" | "float_expanded" | "activity_page";
  includeCompletions?: boolean;
  includeRewards?: boolean;
  intentTaskCode?: string | null;
  intentCompletionEventType?: string | null;
};

type GetPlacementResourcesInput = {
  account?: { cookie?: string; cookieHeader?: string };
  placementCode?: string; // 默认 home.input_below
  clientVersion?: string | null;
};

type ListRewardCardRecordsInput = {
  account?: { userId?: string; user_id?: string; cookie?: string; cookieHeader?: string };
  userId?: string | null;
  offset?: number;
  limit?: number;
  order?: string;
  rewardPackageId?: string | null;
  awardStatus?: string | null;
};

type ListLotteryHitRecordsInput = {
  account?: { userId?: string; user_id?: string; cookie?: string; cookieHeader?: string };
  userId?: string | null;
  offset?: number;
  limit?: number;
  mainPoolId?: string | null;
};
~~~

## 状态依赖

- 从 [M07-配置密钥](../M07-配置密钥/_M07-配置密钥.md) 读取账号 cookie/session 引用。
- 把协议错误交给 [M02-账号池调度](../M02-账号池调度/_M02-账号池调度.md) 处理。
- 模型目录输出给 [M06-兼容网关](../M06-兼容网关/_M06-兼容网关.md)。
- 当 gateway 显式启用协议 env 时，runner 会复用 `listModels()` 的归一化结果做模型权限路由；公开 `/v1/models` 会在此基础上按账号池可选 tier 过滤。未启用时返回空模型列表。`tabbit/priority` 仍作为请求路由兼容保留，但不在公开模型列表中展示。

## 设计约束

- 不能依赖 Playwright 页面作为正常运行时通道。
- 可以在协议还原阶段使用 Playwright 抓样本，但实现路径必须能离线单元测试。
- 所有请求日志必须脱敏 cookie、authorization、邮箱、token。
- 未还原的协议能力必须显式返回 `protocol_changed` 或 `unsupported_feature`，不能假成功。

## 子文档

- [签名头生成](签名头生成.md)
- [模型目录同步](模型目录同步.md)
- [消息发送协议](消息发送协议.md)

## 完成标准

- 有固定签名样本测试。
- 有会话验证、消息发送成功 fixture 和失败 fixture。
- 有真实 `/api/v1/chat/completion` 请求体与浏览器签名头测试，`tabbit/priority` 映射到 `Default`。
- 有 SSE/NDJSON delta 聚合解析 fixture，且不会把 raw wire frame 当成助手文本；buffered OpenAI stream tool_calls 与 Anthropic input_json_delta 会聚合为内部 tool_use block。
- 有显式附件上传路径的签名请求 fixture；有真实 COS 三步上传 fixture，且 raw/base64 附件能在真实发送前上传并映射为 `references[].metadata.file_id`。未完整配置上传链时，raw/base64 附件仍明确失败。
- 有显式 quota usage 路径的 GET fixture，且缺 path/userId/session 时不会触网。
- 有显式只读 commerce 状态/资源路径的 GET fixture，且这些方法不获取 sign-key、不发送 `x-signature` / `x-nonce`、缺 path/session/userId/placementCode 时不会触网。
- 不启动浏览器 UI 也能完成一次文本回复。
- 协议错误能稳定映射到 `ProtocolError.category`。

## 会话验证

`verifySession({ account, session })` 只有在构造 `ProtocolTabbitClient` 时显式传入 `sessionVerifyPath` 才会发起网络请求。默认值是 `null`，返回 `ok:false/category:protocol_missing/code:MISSING_SESSION_VERIFY_PATH`，避免未显式配置时误请求未知路径。当前真实路径已校准为 `GET /api/v0/user/base-info`。

配置后，客户端会先确认 `session`、`account.cookie` 或 `account.cookieHeader` 至少有一个存在；缺失时返回 `category:"session_missing"` / `code:"SESSION_MISSING"`，不会获取 sign key，也不会触网。会话材料存在时，客户端通过 `getSignKey()` 获取签名 key，再对 `sessionVerifyMethod` 和 `sessionVerifyPath` 生成 `x-timestamp`、`x-nonce`、`x-signature`，并把 cookie 放入 `Cookie` header。真实 `GET /api/v0/user/base-info` 成功响应中的 `user_info.id` 会归一化为 `userId`，其他 2xx 响应归一化为 `{ ok:true, userId?, accessTier?, raw }`；401 会归类为 `login_required` 并给出 `accountStatus:"login_expired"`；其他 HTTP 错误沿用 `classifyProtocolError()`。

## 附件上传与自动引用

`uploadAttachment({ account, attachment })` 只有在构造 `ProtocolTabbitClient` 时显式传入 `attachmentUploadPath` 才会请求网络。默认值是 `null`，返回 `ok:false/category:"protocol_missing"/code:"MISSING_ATTACHMENT_UPLOAD_PATH"`，避免猜测未知 Tabbit URL。

只配置 `attachmentUploadPath` 时，客户端保留旧显式上传骨架：复用 `getSignKey()`，对 `POST + attachmentUploadPath + { attachment }` 生成稳定签名头，设置 `Content-Type: application/json`，并在 `account.cookie` 或 `account.cookieHeader` 存在时写入 `Cookie` header。2xx 响应会从 `data` 或顶层对象中归一化附件标识：`id/attachmentId/fileId` -> `attachment.id`，`name/filename/fileName` -> `attachment.name`，`mimeType/mime_type/contentType/type` -> `attachment.mimeType`，`size/bytes` -> `attachment.size`。缺少附件 id 会返回 `protocol_changed`。

同时配置 `attachmentUploadPath=/proxy/v0/cos/presigned-upload-url` 和 `attachmentCompleteUploadPath=/api/v0/cos/complete-upload` 时，客户端走真实 COS 三步上传：`POST` 预签名 URL、`PUT` 文件内容到 COS、`POST` complete-upload。Tabbit 两个 POST 只携带 `Content-Type: application/json`、`trace-id` 和运行时 Cookie，不生成 `x-signature` / `x-nonce`；COS PUT 不携带 Cookie。成功后返回 `attachment.id/name/mimeType/size/url?`。

真实消息体中的附件引用格式已校准：`sendMessage({ attachments })` 在 `/api/v1/chat/completion` 分支接受已上传附件引用（`path/file_id/fileId/id/metadata.file_id`），并生成 document/image `references[].metadata.file_id`。如果附件缺少 file id/path 但包含 `data`、`base64`、`raw` 或 `body`，且已配置完整 COS 上传链，客户端会先自动上传，再把返回的 file id 写入发送请求。未完整配置上传链时，这类 raw/base64 附件仍返回 `unsupported_feature/ATTACHMENT_REFERENCE_REQUIRED`，避免把“客户端给了文件内容”误写成“消息已携带附件”。

## 额度查询

`refreshQuota({ account, userId })` 只有在构造 `ProtocolTabbitClient` 时显式传入 `quotaUsagePath` 才会请求网络。默认值是 `null`，会抛出 `protocol_missing/MISSING_QUOTA_USAGE_PATH`，避免猜测未知权益接口。

当前真实路径已校准为：

~~~text
GET /api/commerce/quota/v1/usage?user_id=<user_id>
~~~

请求使用 `account.userId` / `account.user_id` / input `userId` 作为 query，使用 `account.cookie` 或 `account.cookieHeader` 作为 Cookie，并携带浏览器风格 `unique-uuid` header。抓包未观察到 `x-signature` / `x-nonce`，因此该方法不会调用 `getSignKey()`。

2xx 响应会把 `member_level` 归一化为 `accessTier`，把 `unused_reset_coupon_count` 归一化为 `resetCouponCount`，把 `usage_percentage` 归一化到 `quotaState[0].usagePercentage`，把 `current_cycle_end` 归一化为 `resetAt`。由于响应只有百分比，没有总量或剩余数，`remaining` 和 `limit` 均为 `null`，`unit` 固定为 `usage_percentage`，`usagePercentage >= 100` 时 `exhausted:true`。401/403/429/5xx 等错误复用 `classifyProtocolError()`，因此 401 会作为 `login_required` 抛出，供 BenefitsMaintainer 把账号转为 `login_expired`。

## 只读 commerce 状态/资源探针

以下接口已通过本地脱敏 evidence 校准为只读 `GET`。它们都只使用已登录 Cookie、`accept: application/json`、浏览器风格 `unique-uuid` 和可选 `x-req-ctx`；不会调用 `getSignKey()`，也不会生成 `x-signature` / `x-nonce`。

| 方法 | 真实路径 | 说明 |
|---|---|---|
| `getLotteryExplorationMe({ account })` | `/api/commerce/activity/v1/lottery/me` | 查询当前账号活动抽奖/探索状态。 |
| `getNewbieExplorationMe(input)` | `/api/commerce/activity/v1/newbie-exploration/me` | 查询新人探索状态；`viewMode` 仅允许 `event_gate`、`float_collapsed`、`float_expanded`、`activity_page`。 |
| `getPlacementResources(input)` | `/api/commerce/placement/v1/resources?placement_code=...` | 查询 placement resources；`placementCode` 默认 `home.input_below`，可选 `clientVersion` 会写入 `client_version` query。 |
| `listRewardCardRecords(input)` | `/api/commerce/reward/v1/card-records?user_id=...` | 查询奖励卡记录，支持 `offset`、`limit`、`order`、`rewardPackageId`、`awardStatus`。 |
| `listLotteryHitRecords(input)` | `/api/commerce/lottery/v1/hit-records?user_id=...` | 查询抽奖命中记录，支持 `offset`、`limit`、`mainPoolId`。 |

这些方法是 M05 状态探针，不是维护副作用动作。它们不会参加 `BenefitsMaintainer.maintainAccount()` 默认动作链，也不会替代 `claimProIfAvailable()`、`dailyCheckin()` 或 `useResetCoupon()`。后续若接入领取、签到、抽奖或用券类 `POST`，必须先有真实脱敏 fixture 和独立回归测试。
