# 对象

对象是星历所属的航天器。API 里的一切都挂在它上面。

## 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid | 创建时分配 |
| `object_name` | string | 显示名称，过滤条件与事件流都用它 |
| `norad_id` | integer | 可选。有编目编号时填 |
| `operator_id` | uuid | 归谁所有。由证书决定，不从请求体读 |
| `hard_body_radius` | number（公里） | **必填，必须 > 0** |
| `maneuverability` | boolean | 是否可机动 |
| `alive` | boolean | 是否仍在工作 |

## 硬体半径不是装饰

半径是把最近距离变成概率的那一步：Pc 是两个硬体是否重叠的概率，所以半径为 0 会让
Pc 恒等于 0，而半径填错会让每一个概率都按比例错。报真实的横截面尺度，单位公里——
与筛查内核用的量纲一致。

## 用过滤条件

```bash
# 某运营方的全部对象，按 offset 翻页
curl --key client.key --cert client.crt \
  'https://<host>/api/v1/object?operator_id=<uuid>&limit=50&offset=0'

# 按编目编号取一个对象
curl --key client.key --cert client.crt 'https://<host>/api/v1/object?norad_id=45414'
```

`object_name` 匹配整体值（ASCII 大小写不敏感），不是子串搜索。不是合法整数的过滤值
（例如 `norad_id=abc`）返回 `400`，不会静默返回空列表。

## 配额

每个运营方有 `max_objects`，超出后创建返回 `400`。配额存在是因为对象数量直接决定
筛查成本。

## 常见错误

| 错误 | 会发生什么 |
|---|---|
| `hard_body_radius: 0` | 被接受，此后针对它的每一个 Pc 都是 0 |
| 给同一颗卫星建了第二个对象 | 允许——两个对象是两个身份，筛查按独立对象处理 |
| 以为 `object_name` 是子串搜索 | 不是，只匹配整体值 |
| 读别的运营方的对象 | 返回 `404` 而不是 `403`——不透露其是否存在 |
