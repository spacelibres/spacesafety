# Space Safety

仿制 `space-safety.starlink.com` 的卫星轨道安全与交会筛查平台。
API 名称、数据结构与服务行为与原站一致；实现与部署方式是我们自己的。

当前版本 **0.1.93** —— 完整变更记录见 [`CHANGELOG.md`](CHANGELOG.md)。

> **版本规则**：每次迭代只递增补丁号（`0.1.65` → `0.1.66` → …），
> 并同步更新 `package.json`、`package-lock.json`、git tag 与 `CHANGELOG.md`。
> 提交前请确认这四处一致。

---

## 这是什么

一个**自建**的太空态势感知平台，不依赖任何单一供应商的结论：
把四个权威数据源的编目数据合并成一份带出处的基础库，在上面做轨道传播、
接近筛查与碰撞概率计算，再以与 Starlink Space Safety 相同的 REST 接口对外提供。

**每条数字都能回答「这是谁说的」还是「这是我们算的」**——观测与计算分层存放，
表名本身就能区分。

```mermaid
graph TD
    A["Space-Track<br/>美国 18th SDS"] --> M
    B["DISCOSweb<br/>欧空局 ESA"] --> M
    C["Spacebook<br/>AGI / ComSpoc"] --> M
    D["KeepTrack<br/>开源社区"] --> M
    M["L0 字段声明<br/>每一源的原值"] --> L1["L1 合并<br/>带出处的主表"]
    L1 --> L2["L2 派生<br/>我们算出来的数"]
    L1 --> L3["L3 冲突<br/>未裁决的分歧"]
    L2 --> API["REST API<br/>/api/v1 /api/v2"]
    L1 --> API
    API --> UI["Web UI<br/>Next.js + Three.js"]
```

---

## 基础编目库

四个数据源的原样表**全部保留**，另有一张 157 列的宽表把同一对象的多源取值并排陈列。

> 以下数字为 **2026-11-05** 实测值，随时可跑 `npm run data:health` 复现。
> 源数据每日更新，数字会小幅变化。

| 数据                              | 规模                   |
| --------------------------------- | ---------------------- |
| 宽表 `catalogue_wide`             | **72 435 行 × 157 列** |
| L0 字段声明（每源原值）           | **2 633 721 条**       |
| L1 合并主表 `master_object`       | **72 375** 个对象      |
| 各源轨道元素 `object_sources`     | **64 153** 条          |
| 选定规范星历 `master_element_set` | **32 932** 个对象      |

单源原样表：Space-Track SATCAT 71 231 · 合并 SATCAT 72 310 · DISCOS 对象 71 176 ·
KeepTrack 35 224 · 解体事件 673。

分类（`object_classification`，覆盖 72 435 行）：

| 轨道区域 |   数量 | 用途     |  数量 |
| -------- | -----: | -------- | ----: |
| LEO      | 64 921 | 通信     | 7 274 |
| HEO      |  3 459 | 军事通信 |   533 |
| GEO      |  1 792 | 技术试验 |   375 |
| MEO      |  1 743 | 导航     |   375 |
| UNKNOWN  |    520 | 对地观测 |   338 |

> **缺口不做猜测**：轨道类型 UNKNOWN 520 个、在轨对象刚体半径缺失 1 539 个，
> 保持为空而不是按名称推断。见 [`docs/CATALOGUE-GAPS.md`](docs/CATALOGUE-GAPS.md)。

---

## 交会与碰撞

两类交会数据**并列展示、从不合并**，因为它们是两种不同的主张：

| 来源                |                          规模 | 是什么                                              |
| ------------------- | ----------------------------: | --------------------------------------------------- |
| Space-Track CDM     | **3 728 条报文 → 598 个交会** | 18th SDS 对公开根数做的筛查，无协方差、无运营方申报 |
| CelesTrak SOCRATES  |            **186 789 个事件** | CelesTrak 用自己根数做的独立筛查                    |
| Space-Track TIP     |                     26 248 条 | 再入预报                                            |
| 预测再入 / 解体事件 |                      13 / 673 | KeepTrack、DISCOS                                   |

两者对得上，事件得证；对不上，说明有一方根数已过期——**这正是比对的意义**。

碰撞概率用 **Alfano 方法**计算（与 Starlink 公开文档一致），`2D` 与 `3D` 规格均实现。

---

## 技术栈

| 层           | 选型                                          |
| ------------ | --------------------------------------------- |
| 语言         | TypeScript（含全部脚本与工具，**无 Python**） |
| Web          | Next.js 15 App Router + React 19              |
| 三维         | Three.js / Cesium —— 轨道可视化               |
| 存储         | SQLite（`better-sqlite3`）                    |
| 计算节点通信 | gRPC 双向流（`proto/worker.proto`）           |
| 认证         | mTLS 客户端证书（`npm run cert:issue`）       |

**326 个 TypeScript 文件，约 76 000 行。**

---

## 部署形态

```mermaid
graph TD
    C["外部客户端<br/>mTLS 证书"] -->|REST| V["VPS<br/>API 入口：认证 / 校验 / 存取"]
    W["本地计算节点<br/>传播 · 筛查 · Pc"] -->|gRPC 双向流<br/>主动外连| V
    V --> DB[("SQLite")]
```

计算留在本地，VPS 只做入口。理由：投影与筛查是 CPU 密集且可能长跑的活，
放在入口层会阻塞请求；计算节点主动外连，VPS 无需反向访问内网。

---

## 界面

6 语种（简体中文 / English / Español / Français / Deutsch / 日本語），
侧栏可切换；文案全部来自 `src/lib/i18n/messages/`，缺失键会被 `npm run check` 拦截。

配色与 logo 遵循 [spacelibre VI](https://github.com/spacelibres/vi)。

19 个主要页面：卫星编目（列表 / 分类浏览 / 分类统计 / 详情）、交会事件、
SOCRATES 交会、再入、空间环境、发射与解体、三维模型、轨迹、运营方、
密钥与用户管理。

---

## 数据纪律

这是科学数据，不是演示。几条硬规矩：

1. **单位随物理含义走，不随字段名走。** Space-Track CDM 的 `MIN_RNG` 是**米**，
   同名概念在 CelesTrak 的 `TCA_RANGE` 是**公里**。曾因按字段名假设而错了 1000 倍。
2. **哨兵值不当数据。** CelesTrak 用 `1.000E+00` 表示「未计算概率」，入库时丢弃
   ——因为概率 1 与「必然相撞」无法区分。
3. **缺口保持为空。** 不按名称猜轨道类型，不用 AI 补缺失值。
4. **子集不当全部。** KeepTrack 转发的 SOCRATES 只有 10 行（全是已对接的一对），
   而 CelesTrak 源文件有 197 600 行——后来改取源头。

---

## 自检

```bash
npm run data:health    # 一屏回答「昨晚的数据到底好没好」
```

会同时报：每个源的最后一次**尝试**与最后一次**成功**（`ok` 不等于新鲜）、
派生表行数与输入表并排（表空不等于源空）、以及任何带 `error` 的记录
（HTTP 200 带错误体也算失败）。

---

## 文档

| 文件                                                 | 内容                   |
| ---------------------------------------------------- | ---------------------- |
| [`docs/CATALOGUE-FINAL.md`](docs/CATALOGUE-FINAL.md) | 编目定稿（权威）       |
| [`docs/CATALOGUE-GAPS.md`](docs/CATALOGUE-GAPS.md)   | 已知缺口清单           |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)       | 架构与数值内核         |
| [`docs/DATA-SOURCES.md`](docs/DATA-SOURCES.md)       | 四个源的能力与获取方式 |
| [`docs/SPEC-BEHAVIOR.md`](docs/SPEC-BEHAVIOR.md)     | 服务行为规格           |
| [`docs/UI-SPEC.md`](docs/UI-SPEC.md)                 | 界面规格               |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)                 | 技术栈约束与提交规则   |

---

## 项目规则

技术栈、面向对象标准、版本规则与提交前检查写在 [`CONTRIBUTING.md`](CONTRIBUTING.md)，
是约束性文件。提交前请跑：

```bash
npx tsc --noEmit && npm test && npm run check
```

## 多语言

界面支持 6 种语言：简体中文、English、Español、Français、Deutsch、日本語。
语言由 `locale` cookie 决定，侧栏可切换；文案全部来自
`src/lib/i18n/messages/`，`npm run check` 会拦截缺失、多余或空白的键。

## 命名约定

项目名 **spacesafety**，代码、配置、数据库与 gRPC 包名统一使用这一个名字：

| 位置                     | 值                                                           |
| ------------------------ | ------------------------------------------------------------ |
| 包名 / 目录 / 数据库文件 | `spacesafety`、`data/spacesafety.sqlite`                     |
| 环境变量前缀             | `SPACE_SAFETY_`（全量清单见 [`.env.example`](.env.example)） |
| gRPC 包                  | `spacesafety.worker.v1`                                      |
| 演示认证头               | `x-space-safety-operator`                                    |

## 仓库不含计算数据

星历缓存、SQLite 数据库与 Spacebook 下载文件合计上百 GB，**不入版本库**
（见 `.gitignore` 中的 `data/*`）。克隆后按 `docs/DATA-SOURCES.md` 重新下载即可。
证书私钥（`certs/*.key`）与 `.env.local` 中的凭据同样不入库。

## 快速开始

```bash
npm install
cp .env.example .env.local   # 按需填写凭据；该文件不入库
npm run demo:seed            # 5 颗真实 Starlink 卫星
npm run demo:conjunction -- --seed   # 派生合作目标，产生交会事件
npm run build && npx next start -p 3000
```

打开 <http://localhost:3000>。

演示模式需要两个环境变量（缺一则 API 抛 `401`）：

```bash
SPACE_SAFETY_ALLOW_X_OPERATOR=1 SPACE_SAFETY_DEMO=1 npx next start -p 3000
```

## 参考材料

| 文件                                                         | 内容                                     |
| ------------------------------------------------------------ | ---------------------------------------- |
| [`docs/SPEC-BEHAVIOR.md`](docs/SPEC-BEHAVIOR.md)             | ★ 服务行为规格——实现依据，每条附官方出处 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)               | 部署拓扑、职责划分、数值内核说明         |
| [`docs/UI-SPEC.md`](docs/UI-SPEC.md)                         | ★ 界面视觉与布局规格（依据官方截图）     |
| [`docs/DATA-SOURCES.md`](docs/DATA-SOURCES.md)               | 数据源：官方公开星历入口                 |
| [`docs/ONBOARDING.md`](docs/ONBOARDING.md)                   | 官方 mTLS 凭证申请指南                   |
| [`docs/reference-screenshots/`](docs/reference-screenshots/) | 官方界面截图 27 张                       |
| [`docs/starlink-space-safety/`](docs/starlink-space-safety/) | 官方文档本地快照（33 页）                |

## 架构

```mermaid
graph TD
    C["外部客户端<br/>mTLS 证书"] -->|"REST /api/v1 /api/v2"| V["VPS · Next.js 入口层"]
    V -->|"gRPC 双向流"| W["本地计算节点"]
    V --> DB[(SQLite)]
    W -->|"HTTP 拉取星历"| V
```

- **VPS**：认证、校验、存取、组装响应。不做轨道计算。
- **计算节点**：传播、接近搜索、Alfano Pc。主动外连，无需公网 IP。

## 已实现

### API（18 个端点，与官方同名同构）

| 资源       | 端点                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Operator   | `GET/POST /api/v1/operator`、`GET/PATCH /api/v1/operator/:id`                                                                         |
| Object     | `GET/POST /api/v1/object`、`GET/PATCH/PUT /api/v1/object/:id`                                                                         |
| Trajectory | `GET/POST /api/v1/trajectory`、`GET /api/v1/trajectory/:id`、`GET /api/v1/trajectory/:id/metadata`、`GET /api/v2/trajectory/:id/cdms` |
| CDM        | `GET /api/v2/cdm`、`GET /api/v1/cdm/:id`、`GET /api/v1/cdm/:id/metadata`                                                              |
| Event      | `GET /api/v2/event/:id`、`GET /api/v1/event/:id/cdms`                                                                                 |

行为要点：

- **mTLS 认证**，未携带证书返回 `401 RBAC: access denied`
- **流式分页**：复用 token 取增量，过期返回 `400 pagination_too_old`
- **错误信封**：`{ correlation_id, error, error_type, metadata }`
- `hypothetical` 轨迹及其 CDM 仅提交方可见
- `spacex_optical` 轨迹内容不可读取，只能看 CDM

### 数值内核

| 模块     | 实现                                              |
| -------- | ------------------------------------------------- |
| 传播     | 二体 + J2，RK4                                    |
| 参考系   | ITRF↔J2000 完整 IAU-76/FK5（岁差/章动/GMST/极移） |
| 接近搜索 | 筛查盒 2 / 44 / 51 km（RTN），黄金分割精修 TCA    |
| 碰撞概率 | 二维 Alfano，以硬体圆盘为中心的极坐标积分         |

精度验证：Alfano 与独立参考积分误差 **0.00%**；ITRF→J2000 半长轴
跨 7 天漂移 23.6 km，协方差迹守恒误差 **1e-15**。

### 星历格式

| 格式               | 支持              |
| ------------------ | ----------------- |
| CCSDS OCM          | ✅ 含机动计划解析 |
| CCSDS OEM          | ✅ 协方差段暂忽略 |
| Modified ITC       | ✅                |
| JSpOC / UTC / NASA | 已识别，解析待补  |

### Web UI

按 `docs/UI-SPEC.md` 复刻官方布局：

- 左侧栏 + 环境横幅 + UTC 时钟 + 搜索
- Home（统计 + 3D 轨道视图 + 风险表）
- Operators / Objects / Trajectories / Conjunctions 列表与详情
- 交会详情含 Pc 演化图（对数轴）
- 轨迹详情含轨道根数图（SMA/Inc/Ecc/RAAN/AoP/MA 切换）
- CDM 支持 `json` / `kvn` 下载

## 演示数据

```bash
npm run demo:seed                    # 5 颗真实 Starlink 卫星
npm run demo:conjunction -- --seed   # 派生一个合作目标，产生交会
```

实测输出：8 个交会事件，Pc 覆盖 `1.7e-8` 到 `3.8e-2`。

真实 Starlink 卫星之间不会接近（由主动避碰维持），所以交会事件来自
一个由真实星历派生的合作目标（`--emit` 可导出为 ITC 文件）。

## 分布式运行

```bash
# VPS
SPACE_SAFETY_WORKER_TOKEN=secret npm run vps        # gRPC :50051

# 计算节点
SPACE_SAFETY_GRPC_INSECURE=1 \
SPACE_SAFETY_GRPC_HOST=vps.example.com:50051 \
SPACE_SAFETY_API_ORIGIN=https://vps.example.com \
SPACE_SAFETY_WORKER_TOKEN=secret \
npm run worker
```

已验证闭环：上传 → 入队 → gRPC 下发 → 拉取星历 → 计算 → 回传 → CDM 入库。

## 测试

```
$ npm test
…（53 个套件，每个套件独立进程）…
All 53 suites passed.
```

53 个套件、993 条断言。套件清单由 `tests/*.test.ts` 自动发现，
新增测试文件无需再登记（登记名单曾是手写的，因此漏跑过两个套件）。

## 压测

```
$ npm run bench -- --count 200 --offline
```

测真实星历上的端到端筛查吞吐，并在最后对预筛做硬断言：预筛丢掉的任何一个
交会都会让压测失败。结论（包括不利的部分）见 `docs/ARCHITECTURE.md` 的性能一节。

## 生产部署注意

1. **mTLS 必须在 TLS 终止层完成**，并把证书以 `X-Client-Cert`
   透传给应用（nginx: `$ssl_client_escaped_cert`）。
2. **计算通道必须启用 TLS**：`SPACE_SAFETY_GRPC_CERT/KEY/CA`。
   未配置时生产环境会拒绝启动。
3. `SPACE_SAFETY_DEMO` 与 `SPACE_SAFETY_ALLOW_X_OPERATOR` 仅供演示，
   生产环境不要设置。
