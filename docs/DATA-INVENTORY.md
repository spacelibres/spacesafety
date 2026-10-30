# 数据清单 — 编目与轨道以外的全部数据

**基准：2026-10-30，`data/catalogue.sqlite`。** 随时可用 `npm run data:inventory` 重新核对，
这份文档里的每个数字都是那条命令的输出，不是手抄的。

关于两份**不在本文档范围内**的数据：

| 范围 | 权威文档 | 状态 |
|---|---|---|
| 卫星编目（157 列宽表、分类、多源合并）| `docs/CATALOGUE-FINAL.md` | 已完成 |
| 轨道数据（元素集、星历、轨迹库、derived_state）| —— | 本轮**不整理**（按你的要求先放着）|

本文档管的是剩下的**事件类、环境类、发射类**数据。它们此前有一个共同问题：
**下载成功、入库成功、行数在涨，但没有任何页面或 API 读它们**——11 个数据集、226,637 行，
从用户视角完全不存在。

---

## 一、总表

| 数据 | 表 | 行数 | 最新一行 | 主键 | 消费方 |
|---|---|---:|---|---|---|
| 公开发布的 CDM | `space_track_cdm_public` | 3,164 | TCA 2026-11-01 | `cdm_id` | `/conjunctions`、`/api/v1/cdm?source=public` |
| 再入预测（TIP）| `space_track_tip` | 26,189 | 2026-11-04 | `norad_id`+`msg_epoch` | `/reentry` |
| 再入记录（合并四源）| `space_track_decay` | 143,386 | 2026-12-28 | `norad_id`+`msg_epoch` | `/reentry` |
| 空间天气（逐日）| `space_weather` | 25,232 | 2026-10-30 | `day` | `/environment` |
| 地球定向参数（逐日）| `earth_orientation` | 23,678 | 2026-10-29 | `mjd` | `/environment` |
| 解体事件 | `discos_fragmentation` | 673 | 2026-03-29 | `discos_id` | `/launches` |
| 各国在轨/再入数量 | `space_track_boxscore` | 122 | 快照 | `country` | `/launches` |
| KeepTrack 交会告警 | `keeptrack_conjunction` | 10 | 2026-11-03 | `id` | `/screening/socrates` |
| KeepTrack 发射统计 | `keeptrack_launch_stat` | 4,069 | 2026-10-30 | `kind`+`key1`+`key2` | `/launches` |
| KeepTrack 再入预测 | `keeptrack_reentry` | 14 | 2026-10-30 | `norad_id` | `/reentry` |
| KeepTrack 待发射 | `keeptrack_upcoming_launch` | 100 | 2026-12-31 | `id` | `/launches` |

`npm run data:inventory` 对每张表断言四件事：**无重复主键**、**时间列无空值**、
**逐日序列无缺口**、**物体编号 100% 能在编目表里解析**。当前 11 张表全部通过。

---

## 二、口径（这几条不清楚就会读错数字）

### 2.1 CDM：3,164 条消息 = 509 个交会

`space_track_cdm_public` 一行是**一条消息**，不是一个交会。同一个交会每当估计更新就会重发，
实测一个交会最多收到 14 条消息：

| created (UTC) | TCA | Pc | 最近距离 |
|---|---|---|---|
| 2026-10-28 06:15 | 22:49:39.105 | 0.0004271 | 218 km |
| 2026-10-29 12:46 | 22:49:39.098 | 0.0026593 | 92 km |
| 2026-10-30 05:37 | 22:49:39.096 | 0.0032998 | 71 km |

两条要注意：

1. **TCA 不能当主键**。同一交会的 TCA 在消息之间会抖动几毫秒（`.094` → `.105`），
   按精确 TCA 分组会把一个交会拆成五个。
2. **Pc 会变一个数量级**。把所有消息按 Pc 排序展示，会把**历史上的最坏估计**排在最上面，
   并且当成当前风险。

所以页面与 API 用「物体对 + TCA 相距 60 s 内」折叠（60 s 是实测簇内最大跨度 8.5 s 的 7 倍，
且同一物体对的两个交会不可能落在同一分钟内），每个交会只显示**最新一条消息**，并标出收到几条。

配对是**不分方向**的：同一交会也会以 object1/object2 互换的形式重发（相隔约 4 分钟、数值相同）。

`pc` 为空的 22 个交会保持 `null`，**不写 0**——缺概率不等于零概率，写 0 会把它排到所有
实测概率之下。

### 2.2 再入记录是四源的并集

`space_track_decay` 不是单一文件导入，`source` 列标明来源：

| `source` | 行数 |
|---|---:|
| `60day_msg` | 67,520 |
| `satcat` | 35,740 |
| `TIP_msg` | 26,186 |
| `decay_msg` | 13,940 |

`msg_type` 分 `Prediction`（93,706）与 `Historical`（49,680）。**`decay_epoch` 的含义随
`msg_type` 变**：`Historical` 是 18 SDS 停止跟踪该物体的时刻（既成事实），
`Prediction` 是预测值。读「什么时候再入」必须按 `msg_type` 区分，
否则会把预测当成发生过的事。

同一物体可能同时有 Prediction 与 Historical 两行，主键因此包含 `msg_epoch`（修订历史保留）。

### 2.3 两个逐日序列是完整无缺口的

| 序列 | 首日 | 末日 | 行数 | 跨度 | 缺口 |
|---|---|---|---:|---:|---:|
| `space_weather.day` | 1957-10-01 | 2026-10-30 | 25,232 | 25,232 天 | **0** |
| `earth_orientation.mjd` | 37665 | 61342 | 23,678 | 23,678 天 | **0** |

关键列零空值（F10.7 / Kp / Ap；x、y、UT1-UTC、极移）。这两张表目前**没有消费者**：
轨道侧的传播没有接 EOP，所以下载它们目前只有"备着"的价值——见 §四。

### 2.4 解体事件的位置只有 154/673，成员数无法取得

DISCOS 的 `/api/fragmentations` 只对 154 个事件给了经纬高；`epoch` 只有日期
（`1979-12-15`），没有时刻，因此按日期存、不补零点。

`member_count` 列存在但**恒为 0**，而且拿不到真值：DISCOS 的关系里只有链接，
`meta.pagination` 不含 `total`，`discos_objects` 也不带 fragmentation 反向关系。
这一列是"看起来有值、实际是未知"的陷阱，见 §四第 1 条。

### 2.5 boxscore 是权威方自报的快照

122 行按国家/组织统计在轨与再入数量，无时间列。它和编目算出来的总数**不会完全相等**：
boxscore 是文件生成时刻的快照，会比编目文件多算几个刚拿到编号的物体。
保留它正是因为差异可见，而不是把两者平均掉。

---

## 三、接上了哪些出口

### 页面 `/conjunctions`

分两段，永不混排：

| 段落 | 数据 | 说明 |
|---|---|---|
| 公开发布的交会 | `space_track_cdm_public` 折叠后 509 个 | 带来源说明横幅；风险筛选可用（全部 / 高 / 中 / 低 / 未知，各带条数）|
| 自主筛查 | `cdms`（0 行）| 明确说明为什么空：本部署没有运营方上传星历 |

来源说明必须留着：公开 CDM 是筛查中心对**两个编目物体**的公告，用公开根数算出；
它没有协方差、没有运营方申报、对应不了机动。**不是**本站的筛查结果。

风险带几乎全是"高"是因为该源只发布达到报告门槛（Pc ≥ 1e-4）的交会，
所以筛选在这里主要区分「有 Pc」与「没有 Pc」，页面上也这么写了。

### 页面 `/reentry`、`/environment`、`/launches`

| 页面 | 数据 | 关键口径 |
|---|---|---|
| `/reentry` | TIP（26,189）+ 再入记录（143,386）+ KeepTrack 再入（14）| 只列**时刻仍在未来**的预测；「最近再入」只取 `msg_type='Historical'`，按物体去重取最新消息；历年统计按物体而非消息计数 |
| `/environment` | 空间天气（25,232）+ EOP（23,678）| 两组序列各自显示覆盖区间与缺口数（当前均为 0）；页面明写"尚未接进传播" |
| `/launches` | 待发射（100）+ 发射统计（4,069）+ boxscore（122）+ 解体事件（673）| boxscore 的 `ALL` 行单列，不进国家列表；解体事件缺坐标即为空，成员数不展示 |

三个页面的每个数字都来自 `npm run data:inventory` 校验过的表，且都标注了来源与口径。

### API `GET /api/v1/cdm?source=public`

**这是扩展，不在官方契约里。** 官方语义（`/v1/cdm` 只返回调用方运营方的、
两条星历都是 `operator_ephemeris` 的 CDM）原样保留：不带 `source` 时行为与以前完全一致。

- `?source=public`：返回折叠后的公开交会，每行带 `source: "space-track-public-cdm"`、
  对象二元组、`message_count`，`operator1_id` / `operator2_id` / `event_id` 为 `null`。
- `?source=bogus`：**400 `invalid_source`**，不静默回落到默认语义。

---

## 四、已知未做（每条都有理由）

| # | 项 | 现状 | 需要什么 |
|---|---|---|---|
| 1 | `discos_fragmentation.member_count` 恒为 0 | 上游不提供聚合计数：关系里只有链接，`meta.pagination` 无 `total` | 逐事件翻完所属物体（673 次分页遍历）或等 DISCOS 给 `meta.count`；当前把它当"未知"，不展示 |
| 2 | EOP 与空间天气没有消费者 | 下载入库 25,232 + 23,678 行，传播链路没接 | 属于轨道侧改动，本轮不做 |
| 3 | ~~TIP / decay / 发射类数据没有页面~~ | **已完成**：`/reentry`、`/environment`、`/launches` 三个页面接上全部 11 个数据集 | — |
| 4 | 公开 CDM 无法再筛查 | 无协方差、无运营方申报，设计上就不该当自主筛查输入 | 无（保持两条链路分开）|
| 5 | ~~KeepTrack 四类 feeds 仅入库~~ | **已完成**：交会告警在 `/screening/socrates`，再入在 `/reentry`，发射统计与待发射在 `/launches` | — |

---

## 五、怎么复核

```bash
npm run data:inventory              # 逐表断言：重复主键 / 时间空值 / 逐日缺口 / 编目关联率
npm run data:inventory -- --json    # 机器可读，便于逐日对比
npm run test:events                 # 事件源解析与入库
npm test                            # 含 tests/cdm-cluster.test.ts：消息折叠成交会
```

`data:inventory` 失败即退出码 1。它检查的是**数据本身**，和下载是否成功无关：
下载成功、行数上涨、入库幂等，这些都可以同时为真，而数据仍然读不出来。
