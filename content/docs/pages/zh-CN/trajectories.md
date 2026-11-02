# 星历

星历就是一串随时间采样的位置：物体将在哪里。

## 接受的格式

| 格式 | 靠什么识别 | 说明 |
|---|---|---|
| CCSDS **OEM** | `CCSDS_OEM_VERS` 头 | 通用交换格式 |
| CCSDS **OCM** | `CCSDS_OCM_VERS` 头 | 带协方差；这里的 OEM 不带 |
| Starlink 修改版 **ITC** | `created:` / `ephemeris_start:` 头 | 紧凑格式，公开发布的 Starlink 星历用它 |

格式**靠内容识别**。上传时没有 `format` 字段——一个声明的格式与文件内容不一致，
对两边都是陷阱。

## 上传

```bash
curl --key client.key --cert client.crt -X POST 'https://<host>/api/v1/trajectory' \
  -H 'Content-Type: application/json' \
  -d '{"object_id":"<uuid>","upload_type":"definitive","state_source":"operator_ephemeris","file":"<正文>"}'
```

### `upload_type`

| 取值 | 含义 | 是否筛查 |
|---|---|---|
| `definitive` | 运营方的正式星历——作为记录的方案 | 是 |
| `candidate` | 尚未定稿的候选方案 | 是 |
| `hypothetical` | "如果我这么做会怎样" | **否** |

按契约，`hypothetical` 永不进入筛查。一个会生成告警的假设方案，是对方无法处置的误报。

### `state_source`

运营方提供的一律是 `operator_ephemeris`。`spacex_optical` 标记 Stargaze 观测来源，
只能通过 `/api/v2` 访问——见 [Stargaze](/docs/tutorial-basics/stargaze)。

## 校验，以及为什么严格

被拒绝的上传会逐条列出所有问题，而不是只报第一个：

```json
{
  "correlation_id": "1f0a…",
  "error": "trajectory failed validation (2 issues)",
  "error_type": "trajectory_invalid",
  "metadata": {
    "issues": [
      { "field": "file", "reason": "at least 6 state vectors are required (got 2)" },
      { "field": "file", "reason": "trajectory ends more than 24 hours in the past" }
    ]
  }
}
```

| 规则 | 原因 |
|---|---|
| 状态点 ≥ 6 个 | 更少的点无法可信插值，算出来的 TCA 只是插值的产物 |
| 不能整段结束于 24 小时之前 | 对已关闭的窗口做筛查，等于拿今天的编目去报告一个不可能发生的交会 |
| 时间必须能无歧义解析 | 悄悄错位的历元会把每个算出的 TCA 一起挪走 |

24 小时规则**只在上传时**生效。已入库的星历在窗口关闭之后仍可筛查：失效的不是弧段，
是时钟走了一格。

## `screened_status`

六个取值，就是官方那一套：

| 取值 | 含义 |
|---|---|
| `not_screened` | 排队中，或从未尝试 |
| `screened` | 筛查完成 |
| `superseded` | 该对象更晚的星历取代了它 |
| `candidate_to_definitive` | 候选方案被提升为正式 |
| `unknown_trajectory_fetching_error` | 计算节点取不到文件 |
| `failed_interpolation` | 状态无法插值（有缺口，或 TCA 落在跨度之外） |

## 读回来

```bash
# 原样返回上传的字节
curl --key client.key --cert client.crt 'https://<host>/api/v1/trajectory/<uuid>'

# 同一条轨道用 ITRF 表达
curl --key client.key --cert client.crt 'https://<host>/api/v1/trajectory/<uuid>?reference_frame=itrf'
```

`reference_frame` 接受 `original`（默认）、`itrf`、`eme2000`。响应带 `x-reference-frame`，
把"你实际拿到的是哪个系"写出来而不是让人猜。变换是物理的，不是装饰性的：转 ITRF 时
速度要减掉 ω×r（赤道上约 0.47 km/s）。只旋转不加这一项，是个看起来很对的错误答案。
