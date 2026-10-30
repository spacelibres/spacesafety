# 缺口清单（Gap Register）

本文件是**所有已知缺口的唯一索引**：每一条都写明现状、影响、以及"补 / 不补"的决定与理由。

配套文件：

| 文件 | 管什么 |
|---|---|
| `docs/CATALOGUE-FINAL.md` | 编目数据的唯一权威（数字以它为准）|
| `docs/DATA-SOURCES.md` | 数据源盘点、各源更新频率、抓取与调度的用法 |
| `docs/CATALOGUE-GAPS.md` | 数据缺口的**详查过程**（本文件只给结论）|
| `CONTRIBUTING.md` | 约束性规范 |

状态口径：

- **已补** —— 已经在代码/数据里落地，并有可复跑的验证
- **不补** —— 定稿决定接受，理由见条目（**禁止用猜测值填充**）
- **待定** —— 需要产品决定，代码里已标注

最后更新：2026-10-30　｜　对应版本 v0.1.65

---

## 一、数据缺口

| # | 缺口 | 数量 | 状态 | 理由 / 证据 |
|---|---|---|---|---|
| D1 | 轨道类型 `UNKNOWN` | 523 | **不补** | 缺 apogee/perigee 且无来源声明；只能靠名称猜，猜测值与实测值无法区分（污染统计）。`CATALOGUE-FINAL` §6.1 |
| D2 | 硬体半径在轨缺失 | 1,539 | **不补** | 其中 1,111 是分析型目标（身份未知，不会有物理模型）、337 上游无模型、91 仅 KeepTrack/DISCOS；可推算的只有 2 个。`CATALOGUE-FINAL` §6.2 |
| D3 | 目标分类 `UNKNOWN` | 1,317 | **不补** | 各源都不给；DISCOS 有最细分类但不覆盖这些对象。`tools/hbr-gap-candidates.ts` |
| D4 | 已再入对象的物理量缺失 | 32,198 | **不补** | 不影响在轨 Pc 计算，补齐无收益 |
| D5 | 分析型目标没有身份 | 1,112 | **不补** | 传感器确认不了身份才放进预留号段，这是数据本身的语义 |

**刷新后实测（2026-10-30）**：宽表 72,402 × 157，分类表 72,402（零缺口）；
五源覆盖 71,198 / 71,088 / 71,176 / 34,006 / 1,112，与定稿逐项一致。

---

## 二、已补的缺口（本次及近期）

| # | 缺口 | 补法 | 验证 |
|---|---|---|---|
| G1 | `object_field_claim` 是空表（逐字段出处机制从未生效）| `master:build` 在当前数据上从未跑过；跑一次即写入 **2,632,777** 行 | `SELECT COUNT(*) FROM object_field_claim` |
| G2 | `catalogue:build` 静默删表 | 它只从工作库复制固定表，**14 张只存在于目标库的表会被删掉**（KeepTrack 全部 + `object_classification` + 全部事件表）。现在**先检测后拒绝**，并把表名打出来 | `npm run catalogue:build` → 拒绝并列出 14 张表 |
| G3 | `screened_status` 缺 2 个官方取值 | 补齐 `unknown_trajectory_fetching_error` / `failed_interpolation`，接到 gRPC 失败分类 | `tests/api-contract.test.ts` |
| G4 | 弃用端点 `GET /v1/event`、`GET /v1/cdm` 是 404 | 补齐，按官方口径限定 operator + `operator_ephemeris` | 同上 |
| G5 | `/api/v2/cdms`（复数）是 404 | 别名 re-export 单数实现 | 同上 |
| G6 | `?reference_frame=` 被忽略 | 实现 `original` / `itrf` / `eme2000`（含 ω×r 速度修正）| 同上，含往返解析校验 |
| G7 | 限流不存在（`ApiError.rateLimited` 从未被调用）| per-operator 令牌桶，超限 503 + `Retry-After` | 同上 |
| G8 | 侧栏用文字冒充 VI logo | 改为内联 VI 母版，颜色绑 token；新增检查 8e | `npm run check` / 浏览器实测 |
| G9 | 三个 token 低于 4.5:1 | `legibleOnSurfaces` 对每张底色推导 | `tests/vi-tokens.test.ts` |
| G10 | 色系只有手抄的 16 个值 | 移植 VI 的 `generatePalette`，六套预设回放 **96/96** 一致 | 同上 |
| G11 | 整页有滚动条 | 应用外壳：文档不滚，内容区滚动且隐藏滚动条 | `npm run audit:viewport`（14 页 × 7 视口）|
| G12 | 无法安装到桌面 | manifest + SW + VI 图标 | `Page.getInstallabilityErrors` 返回空 |
| G13 | 两个测试套件没接进 `npm test` | 自动发现 `tests/*.test.ts` | 35 → 40 套件 |
| G14 | 没有更新的数据也照下不误（"到期"就等于"重传整份"）| 四层判断：节奏 → 条件请求（304）→ gzip → 归档同哈希；无新字节不重建 | `tests/http-conditional.test.ts`（304 且 socket 主体 0 字节）；实测 omm/json 30.37 MB → 7.23 MB |
| G15 | `data:daily` / `data:schedule` 跑过下载就重建 | 按台账判定：本轮有 `status='ok'` 的行才跑 load → wide → classify → events | 全 304 时打印"跳过重建"并返回 0 |
| G16 | 测试 fixture 手抄表结构，加列后与真实库漂移 | 真实 DDL 抽成 `src/db/ddl.ts` 的 `SCHEMA_DDL`，fixture 直接用它 | `tests/sources.test.ts` 43 条全过 |
| G17 | 只有 `download()` 要压缩，其余四个出口没有 | `src/lib/net/encoding.ts` 的 `ACCEPT_ENCODING` 接进全部五条传输路径（含 SOCKS5 分支，它原先既不要压缩也没有解码器）| `tests/http-encoding.test.ts` 9 条；实测每日 1.13 GB → 0.63 GB |
| G18 | SOCKS5 分支会把压缩字节当正文 | 该分支 `decodeBody()` 解码并删除 `content-encoding` / `content-length` | 解码器单测覆盖；**代理链路本身未端到端实测**（本机无代理节点）|
| G19 | 11 个数据集、226,637 行入库后无人读取 | 逐表断言 + 清单文档；公开 CDM 接到 `/conjunctions` 与 `/api/v1/cdm?source=public` | `npm run data:inventory`（11 表全过）；`docs/DATA-INVENTORY.md` |
| G20 | 公开 CDM 按消息逐行展示，把历史最坏 Pc 当当前风险 | 按「物体对 + TCA 60 s 内」折叠：3,164 条消息 → 509 个交会，只显示最新估计并标出消息数 | `tests/cdm-cluster.test.ts` 8 条 |

---

## 三、待定 / 已知未做

| # | 项 | 现状 | 需要什么 |
|---|---|---|---|
| P1 | `<title>` / `description` 渲染在 body | App Router 的异步 metadata 会冲到文档末尾（`</head>` 在 1,095 字节，`<title>` 在 16,072 字节）。浏览器仍用它做窗口标题，但位置不合规 | 把 metadata 改成静态导出（会失去按语言切换标题）——权衡后暂不动 |
| P2 | `master:build` 依赖库布局 | 单文件布局跑它，`master_element_set` 会变 0（星历库未挂载）| 应用侧**没有**任何代码读这两张表，暂无影响；要恢复需 split 布局 |
| P3 | 限流是进程内的 | 多实例部署时上限 = 实例数 × 600 | 桶挪到共享存储（Redis）|
| P4 | `Users` 页不是"仅管理员" | 本部署没有角色模型，只有"有没有有效证书" | 先做鉴权设计变更 |
| P5 | 弃用 v1 列表端点的响应字段是我们定的 | 官方快照未规定该形状，已按 v1 字段名（`created_at`/`tca`）实现并注明 | 无（已声明选择）|
| P6 | `spacebook-satcat` 账本与归档可能不一致 | 一次 `--force` 写了归档未留账本行；调度器会自重抓并记账 | 已自愈；建议把"归档日"与"账本"交叉校验成检查项 |
| P7 | 开发期无自动调度 | systemd 用户级 timer 曾安装并验证，后按开发需要**已停用**；`deploy/systemd/` 保留文件 | 上线时：`systemctl --user enable --now spacesafety-data.timer` |
| P9 | 同一批 OMM 记录取三种编码 | `omm/kvn` 304 MB/日（服务端不压缩）+ `omm/json` 87 + `omm/xml` 48 = 439 MB/日，占全部 68%。kvn/xml 只用于验证"字段集与格式无关" | 把 `spacebook-omm-kvn` 的 `refreshMinutes` 120 → 1440 即降到约 365 MB/日；属数据节奏决策，等确认 |
| P10 | 8 个 Spacebook 端点不压缩 | `omm/kvn`、`omm/xml`、`entity/tle`、`xp-tle`、两个 csv、`eop`、`weather` 不发 `content-encoding`（kvn 连 `br` 也不行）| 客户端无解法；能省的只有 P9 的重复取数 |
| P11 | EOP 与空间天气无消费者 | 25,232 + 23,678 行仅入库，传播链路没接 EOP | 属轨道侧改动，按你的要求本轮不做 |
| P12 | 再入 / 发射 / 解体事件没有页面 | 143,386 + 26,189 + 4,183 + 673 行仅入库 | 需要新页面（已确认本轮不新建）|
| P13 | `discos_fragmentation.member_count` 恒为 0 | 上游只给关系链接，`meta.pagination` 无 `total`，`discos_objects` 无反向关系 | 逐事件分页遍历（673 次）或等 DISCOS 提供计数；当前按"未知"处理 |
| P8 | 条件请求目前省 0 字节 | 实测 Spacebook / Space-Track / DISCOS **都不发** `ETag` / `Last-Modified`，多数还带 `cache-control: no-store`。机制已就绪且无副作用，去掉反而会丢掉将来 CDN 支持时的收益 | 无客户端解法：没有 validator，就无法在传输前判断内容是否变化。当前的省法是 gzip + 节奏 + 同哈希不重建、不重算 |

---

## 四、尚未触及的数据源

| 源 | 状态 |
|---|---|
| LeoLabs | 有商业 API，未申请密钥 |
| CelesTrak | KeepTrack 已代理其 TLE 与 SOCRATES |
| Spacebook `/api/Scene`、`/api/UserEphemeris` | 实测为空数组（用户上传内容，本账号无上传），非授权问题 |
| 三维模型（299 个 `.glb`）| 变动极少，**不参与每日刷新**；需要时 `npm run models:sync` |

---

## 五、怎么复核这份清单

```bash
npm run test:wide              # 宽表/分类表的真实查询
npm run check                  # 规则自检（含每 tag 自带版本、构建产物可解析、VI 一致）
npm run data:schedule -- --status   # 各源频率 / 上次成功 / 是否到期
npm run audit:viewport         # 14 页 × 7 视口无滚动条（需 dev 或 prod 服务在跑）
npx tsx tools/catalogue-source-overlap.ts   # 五源覆盖与重叠
npx tsx tools/hbr-gap-audit.ts              # 硬体半径缺口拆分
```

任何数字与本文件不符时，**以 `docs/CATALOGUE-FINAL.md` 与数据库实测为准**，并回来改这一份。
