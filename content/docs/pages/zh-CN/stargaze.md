# Stargaze 观测

Stargaze 是一种光学观测来源：位置来自望远镜图像，而不是运营方自己的星历。
在这个 API 里，这类星历的 `state_source` 是 `"spacex_optical"`。

## 为什么它是单独的一种来源

运营方星历是**计划**：卫星打算在哪里。光学观测是**测量**：它在哪儿被看到。
把两者对比，才找得出真实的偏差——但它们不是同一个问题的可互换答案，
所以 API 从不悄悄用一个替代另一个。

| 来源 | 含义 | 是否与运营方星历互相筛查 |
|---|---|---|
| `operator_ephemeris` | 运营方自己的计划 | 是 |
| `spacex_optical` | 光学观测得到的位置 | 是，作为它自己的星历 |

## 它出现在哪里

| 端点 | 是否包含 Stargaze CDM |
|---|---|
| `/api/v2/cdm` | **包含** |
| `/api/v2/trajectory/:id/cdms` | 包含 |
| `/api/v1/cdm`（弃用） | **不包含**——按契约只返回两边都是 `operator_ephemeris` 的 CDM |
| `/api/v1/event`（弃用） | 不包含——同一套限定 |

这种不对称不是疏漏。弃用端点服务于按旧教程写的客户端，承诺的是"只含运营方数据"；
悄悄掺进第二种来源，等于不动声色地毁约。

## 怎么读

```bash
# 涉及某条光学星历的全部 CDM
curl --key client.key --cert client.crt \
  'https://<host>/api/v2/cdm?trajectory_id=<uuid>'

# 把流过滤到光学来源的星历
curl --key client.key --cert client.crt \
  'https://<host>/api/v2/cdm?operator1_id=<uuid>&trajectory1_source=spacex_optical'
```

## 本部署的现状

这里没有接入光学观测流：`spacex_optical` 是 `state_source` 与 `trajectory1_source`
的合法取值，但没有任何星历带这个值。写进文档是因为这个参数属于契约，
不是因为背后有数据。
