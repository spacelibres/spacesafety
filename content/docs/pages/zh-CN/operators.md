# 运营方

运营方是拥有对象的账号。它是身份的单位、配额的单位，也是证书能读什么的边界。

## 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid | 每个对象与星历都引用它 |
| `name` | string | 显示名称 |
| `email` | string | 协同联系人 |
| `phone` | string | 协同联系人 |
| `max_objects` | integer | 对象配额 |

`email` 与 `phone` 不是摆设：交会协同是人跟人对齐，事件流同时列出双方运营方，
就是为了让人知道该打给谁。

## 新建与更新

```bash
curl --key client.key --cert client.crt -X POST 'https://<host>/api/v1/operator' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Example Operator","email":"ops@example.test","max_objects":500}'

curl --key client.key --cert client.crt -X PATCH 'https://<host>/api/v1/operator/<uuid>' \
  -H 'Content-Type: application/json' -d '{"max_objects":800}'
```

`PATCH` 是部分更新：未提供的字段保持原值。空请求体是合法的 `PATCH`，什么都不改——
那不是错误。

## 运营方不能决定的事

| 说法 | 实际 |
|---|---|
| "我可以读涉及我对象的所有 CDM" | 可以——但必须在过滤条件里指名自己 |
| "我的配额是按请求算的" | 不是——它数的是对象个数，在创建时校验 |
| "建一个运营方就拿到了凭据" | 不是——凭据是证书，线下签发 |

## 一个事件里的两个运营方

交会是双向的，事件记录保留双方各自的申报状态。任何一方的申报都不从另一方推断，
也绝不从卫星的实际行为去推断。
