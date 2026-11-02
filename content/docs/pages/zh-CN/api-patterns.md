# API 通用约定

这些约定适用于所有端点。客户端不必逐页读也能依赖的那部分契约都在这里。

## 信封

批量列表端点返回同样两个字段：

```json
{ "result": [ /* 行 */ ], "token": "eyJ2IjoxfQ" }
```

`result` 是你要的这一页。`token` 是下一页的游标，且**不透明**——不要解析、
不要推导、不要自己拼一个。

## 分页

| 规则 | 行为 |
|---|---|
| 原样带回 | `?token=<上一页响应里的值>` |
| 不带 `token` | 第一页 |
| `token` 与签发它时的过滤条件不一致 | `400`——游标绑定产生它的那组过滤条件，换条件续读会静默跳过行 |
| 游标过期 | `400 pagination_too_old`——从第一页重新发起 |
| 数据到底 | 最后一页仍带 `token`；**下一次**请求返回空的 `result` |

存在两种分页风格，混用是最常见的错误：

- **游标**（`token`）用于边读边可能追加的流式端点；
- **偏移**（`limit`、`offset`）用于 `GET /v1/object` 与 `GET /v1/operator`，
  这两处按名称排序，翻页看到的是稳定序列。

## 错误

所有失败共用一个形状：

```json
{
  "correlation_id": "1f0a…",
  "error": "人类可读的信息",
  "error_type": "机器可读的代码",
  "metadata": {}
}
```

| 状态码 | 含义 | `error_type` 示例 |
|---|---|---|
| `400` | 请求本身有问题——参数错、缺必需过滤条件、或校验未通过 | `bad_request`、`trajectory_invalid`、`invalid_source`、`pagination_too_old` |
| `401` | 没有有效的客户端证书 | `unauthorized` |
| `404` | 该行不存在，或不属于你 | `not_found` |
| `503` | 超过速率上限 | `rate_limited` |

`metadata` 装与这条信息配套的细节：校验问题放在 `{"issues":[{"field":"file","reason":"…"}]}`，
出错参数名放在 `{"parameter":"upload_type"}`。

## 速率限制

按运营方用令牌桶计量。**一次读消耗 1 个令牌，一次写消耗 10 个**，一个预算同时约束
两类流量：轮询的客户端永远碰不到它，而上传循环被压到十分之一。

桶空时返回 `503` 并带 `Retry-After`：

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 60
```

请遵守 `Retry-After`。不带它的 503 等于"立刻重试"的指令，会把限流变成自伤式拒绝服务。

额度在调用时读 `SPACE_SAFETY_RATE_LIMIT_PER_MINUTE`（默认每分钟 600 次读），
改配置不需要重启。

## 时间

| 位置 | 格式 |
|---|---|
| `created_at`、`uploaded_at`、`start_at` 等 | RFC 3339 UTC，如 `2026-11-02T05:00:07.000Z` |
| `tca_gps_nanos`、`first_cdm_tca_gps_nanos` | GPS 纳秒，**字符串** |

纳秒用字符串是因为 2⁶³ 过不了 JavaScript 的 number：值会被四舍五入，而四舍五入过的
TCA 已经是另一个交会了。`tca_min` / `tca_max` 两个过滤参数用的是**秒**。

## 过滤条件

过滤条件是叠加的（AND），并且**校验而不是忽略**：

- 取值未知的过滤条件返回 `400`，绝不当成无操作。`upload_type=banana` 不会返回全部，
  而是返回一个指名该参数的错误。
- 过滤条件之间的依赖会被强制：只给 `operator2_id` 而不给 `operator1_id` 是 `400`，
  因为单独的"第二个参与方"没有意义。
- 会返回全系统的列表端点要求至少一个限定条件（`/v2/cdm` 需要
  `operator1_id`、`trajectory_id`、`object1_id` 之一）。

## 请求

- 除返回文件的端点外，用 `Accept: application/json`。
- `POST` / `PATCH` 用 `Content-Type: application/json`。
- 未知的请求体字段会被忽略；已知字段类型不对返回 `400`。
