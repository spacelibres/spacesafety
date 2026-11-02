# 快速开始

API 通过 HTTPS 提供服务，用**客户端证书**识别调用方。每个请求都带同一对文件，
不需要先换一个 bearer token。

```bash
curl --key client.key --cert client.crt \
  -H 'Accept: application/json' \
  'https://<host>/api/v1/operator'
```

没带证书时，所有端点一律返回 `401 RBAC: access denied`。见[API 密钥与身份](/docs/api-keys)。

## 1 · 找到你要写入的运营方

```bash
curl --key client.key --cert client.crt 'https://<host>/api/v1/operator'
```

返回里的 `id` 就是对象与星历的归属。本部署这份名单很短——它装的是在这里登记过的
运营方，不是公开注册表。

## 2 · 新建对象

对象是星历所属的航天器。`hard_body_radius` 必填且必须大于 0：它就是计算碰撞概率
用的半径，为 0 会让 Pc 恒等于 0。

```bash
curl --key client.key --cert client.crt -X POST 'https://<host>/api/v1/object' \
  -H 'Content-Type: application/json' \
  -d '{"object_name":"STARLINK-1309","hard_body_radius":0.00413,"norad_id":45414,"maneuverability":true}'
```

返回 `{ "id": "<uuid>" }`。

## 3 · 上传星历

请求体就是星历正文。接受 CCSDS **OEM**、CCSDS **OCM** 与 Starlink 修改版 **ITC**；
格式靠内容识别，不需要声明。`upload_type` 决定它是否参与筛查。

```bash
curl --key client.key --cert client.crt -X POST 'https://<host>/api/v1/trajectory' \
  -H 'Content-Type: application/json' \
  -d '{
    "object_id": "<uuid>",
    "upload_type": "definitive",
    "state_source": "operator_ephemeris",
    "file": "<ephemeris.oem 的内容>"
  }'
```

校验很严格，而且会说明原因：被拒绝时每个问题一条，例如
`{"field":"file","reason":"at least 6 state vectors are required (got 2)"}`。

## 4 · 观察筛查状态

```bash
curl --key client.key --cert client.crt 'https://<host>/api/v1/trajectory/<uuid>/metadata'
```

`screened_status` 从 `not_screened` 起随筛查推进。六个可能取值列在
[星历](/docs/tutorial-basics/trajectories)一节。

## 5 · 读 CDM

要轮询的是 `GET /api/v2/cdm`。`operator1_id`、`trajectory_id`、`object1_id` 至少给一个——
本服务不提供"把全系统 CDM 一次拉完"的用法。

```bash
curl --key client.key --cert client.crt \
  'https://<host>/api/v2/cdm?trajectory_id=<uuid>&only_active=true'
```

响应是 `{ "result": [...], "token": "..." }`。把 `token` 带回去取下一页；
拿到 `token` 却不取下一页，等于有一页没读。见 [API 通用约定](/docs/api-patterns)。

## 接下来看什么

| 你想 | 看 |
|---|---|
| 弄清一条 CDM 里有什么 | [CDM](/docs/tutorial-basics/cdms) |
| 知道事件是怎么聚合的 | [交会事件](/docs/tutorial-basics/events) |
| 决定轮询节奏 | [最佳实践](/docs/space-safety-articles/best_practices) |
| 精确查某个端点 | [API 参考](/docs/api/get-cd-ms) |
