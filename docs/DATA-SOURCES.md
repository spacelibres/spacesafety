# 数据源

> 数据源分三层：**Starlink 运营方星历**（OCM / ITC，精度最高）、
> **Space-Track**（最新历元）、**Spacebook**（覆盖最广）。
> 三者全部入库、互不覆盖，通过 `npm run sources:compare` 交叉验证。

## 0. 多源汇聚总览 ★

每个源都有不同的凭据、更新频率与字段覆盖。**同一颗卫星在多个源里各存一份**，
不做覆盖，这样才能互相校验。

| 源 | 凭据 | 刷新 | 覆盖 | 实测历元年龄 |
|---|---|---|---|---|
| Space-Track `gp` | **需登录** | 2 h | 30 743 | **最新**（基准） |
| Spacebook OMM | 公开（需代理） | 2 h | 32 809 | 与 Space-Track 相同 |
| Spacebook entity/TLE | 公开（需代理） | 2 h | **32 809** | 与 OMM 相同（比 XP-TLE 新） |
| Spacebook XP-TLE | 公开（需代理） | 2 h | 29 566 | **落后 17–77 h** |
| Spacebook SATCAT | 公开（需代理） | 24 h | 72 310 | — |
| Spacebook SATCAT supplemental | 公开（需代理） | 24 h | 72 310 | 含**协方差时间窗** |
| Starlink OCM | 公开 | 8 h | 11 162 | 运营方 7 天弧 |

> `entity/tle` 与 `xp-tle` 是同一类数据的两个端点。实测按 NORAD 去重：
> `entity/tle` 32 809 个唯一对象，`xp-tle` 29 668，前者**多 3 234 个**，
> 且历元与 OMM 一致（比 XP-TLE 新 3 天）。**优先用 `entity/tle`**。

凭据写在 `.env.local`（已 gitignore）：

```
SPACE_SAFETY_SPACETRACK_USER=...
SPACE_SAFETY_SPACETRACK_PASS=...
SPACE_SAFETY_PROXY=socks5://127.0.0.1:20170
```

### 三种表的职责

| 表 | 粒度 | 用途 |
|---|---|---|
| `data_sources` | 每源一行 | 注册表：凭据变量、刷新周期、优先级、最近成功时间 |
| `source_fetches` | 每次抓取一行 | 审计：为何数据旧了——源挂了还是调度没跑 |
| `object_sources` | **(对象, 源) 一行** | 交叉校验的原始证据 |

`object_sources` 是关键。早期版本把两个源的 TLE 都写成 `state_source='tle'`，
第二次写入直接覆盖第一次，**对比证据在写入时就丢了**。

### 一个实测发现：Spacebook XP-TLE 系统性滞后

对同一颗卫星比较两源的历元与根数（2026-10-29）：

| 对象 | 历元差 | 分离 |
|---|---|---|
| ISS | 54 h | 276 km |
| STARLINK-1008 | 77 h | 4 337 km |
| VANGUARD 1 | 17 h | 246 km |

mean motion 的差与历元差**成正比**——这不是数据错误，是陈旧根数。
所以 XP-TLE 用于**覆盖面**，Space-Track 用于**新鲜度**。

### 判定逻辑（重要）

初版用固定公里阈值，结果 57% 的目标被误判为「异常」。正确做法是**按天漂移率**：

| 条件 | 判定 |
|---|---|
| 同历元且差 < 5 km | `agree` — 两源发布的是同一份根数 |
| 漂移 < 50 km/天 | `agree` |
| 50–3 000 km/天 | `stale` — 正常的根数老化 |
| > 3 000 km/天 | `suspect` — 需人工确认 |

`suspect` 还会给出原因分类：

- `same-epoch-disagreement` — 同历元却不一致，**真正的数据矛盾**
- `uncontrolled-object` — 碎片/火箭体，无轨道保持，短弧就分离
- `high-orbit` — 高轨，无阻力外推在数天内发散
- `unexplained` — 无法解释，值得人工看

### OCM 与 TLE 的关系（实测）

STARLINK-1008：OCM 与 Space-Track TLE 的**轨道半径完全吻合**（|r| 差 ≤ 3.7 km），
但沿迹相位差 1 800–9 000 km，且随历元差振荡。这是 SGP4 沿迹误差的典型表现，
也正是 **TLE 不能用于精密定轨**的直接证据。

```bash
npm run sources:refresh                    # 按各源周期刷新
npm run sources:refresh -- --force         # 强制全部刷新
npm run sources:compare                    # 交叉验证 2 000 个样本
npm run sources:compare -- --norad 44714 --verbose
```

## 0.1 协方差覆盖（决定能否算 Pc）

SATCAT supplemental 给出每个对象的**协方差时间窗**，这是 Pc 可算性的前置条件：

| 状态 | 对象数 | 其中带协方差 |
|---|---|---|
| Debris | 35 943 | 12 341 |
| Active | 18 524 | **17 479** |
| Dead | 10 759 | 5 536 |
| RocketBody | 6 919 | 2 465 |
| Unknown | 165 | 114 |
| **合计** | **72 310** | **37 935** |

也就是说：**37 935 个对象有协方差窗口**，远多于 Starlink 的 11 162 颗。
筛查队列可以直接查 `satcat.covariance_start` 跳过无法产出 Pc 的对象，
而不是尝试 4 万次再失败。

> 落地时踩过：supplemental 用 `entityId` 关联（没有 NORAD），
> 因缺索引导致 7.2 万次全表扫描，**3 分钟没跑完**（看起来像网络卡死）。
> 加 `satcat_entity_idx` 后 **1 秒**完成。

## 0.2 ESA DISCOSweb（第三个源）

DISCOSweb 是 ESA 太空环境报告办公室维护的数据库，与其他两源的重叠在于身份，
**不同在于物理模型**：

| | Space-Track | Spacebook | DISCOSweb |
|---|---|---|---|
| 对象数 | 71 198 | 72 310 | **93 692** |
| 物理参数 | 无 | RCS 分级 | **质量、形状、直径、横截面积** |
| 来源 | 18th SDS | COMSPOC | ESA，运营方申报 |

物理模型是唯一能**改变计算结果**而不只是描述的东西：碰撞截面需要面积和形状，
另两源都不提供。

### 实测覆盖（2026-10-29，93 692 条）

| 字段 | 有值的对象数 |
|---|---|
| `mass` | **42 327** |
| `xSectAvg` / `xSectMax` / `xSectMin` | **41 188** |
| `shape` / `width` / `height` / `depth` / `span` | ~41 000 |

STARLINK-1008（NORAD 44714）实测记录：

```json
{ "mass": 260, "shape": "Box + 1 Pan", "width": 3.7, "height": 0.1,
  "depth": 1.5, "span": 8.86,
  "xSectMax": 23.657, "xSectMin": 0.2311, "xSectAvg": 13.5615 }
```

意义：横截面积从 0.23 到 23.66 m² 相差百倍，**迎风姿态不同，碰撞风险完全不同**。
用固定 RCS 分级估算会把这一项误差带到 Pc 里。

### 认证方式（重要）

DISCOSweb 用 **Personal Access Token**，不是账号密码：

```
Authorization: Bearer <token>
DiscosWeb-Api-Version: 2
Accept: application/vnd.api+json
```

账号密码只能登录网页，**无法通过 API 换取 token**（实测）：

| 尝试 | 结果 |
|---|---|
| `POST /api/auth/login` | 400 “The CSRF token is missing”（它是浏览器表单） |
| `GET /api/auth/login` | 401 unauthorized |
| `POST /api/auth` | 405 Method Not Allowed |

Token 在 `https://discosweb.esoc.esa.int/tokens` 生成，写入
`.env.local` 的 `SPACE_SAFETY_DISCOS_TOKEN`。

### 规模与并发（实测）

**全部 16 个集合合计 1 926 页**，8 并发下约 **30 分钟**跑完：

| 资源 | 页数 | 记录数 |
|---|---|---|
| `objects` | 937 | 93 692 |
| `initial-orbits` | 642 | ~64 000 |
| `destination-orbits` | 232 | 23 192 |
| `launches` | 74 | 7 379 |
| `launch-vehicles/engines` | 10 | ~1 000 |
| `launch-vehicles/stages` | 9 | ~900 |
| `fragmentations` | 7 | 673 |
| 其余 9 个集合 | 15 | <500 |

单页约 1.1 秒，`page[size]` **硬上限 100**（请求 500/1000 均返回
`400 pagination:invalid`），无法靠加大页宽提速。

并发实测（同一 token）：

| 并发 | 结果 |
|---|---|
| 8 | 全部 200 |
| 16 | 爬虫运行中时全部 429 |
| 32 | 约一半 429 |

限流是**全局限速**，不是按页计费，所以提高并发不会提高吞吐。
默认并发 8，遇 429 时**自动减半 + 指数退避**（30s 起，上限 10 分钟）。

> 踩过的坑：初版退避只有 3 秒，6 次重试全部失败于第 104 页；
> 而实际上 token 只需等一分钟。退避必须按分钟级设计。

### 断点续传

93,692 页不可能一次跑完。`PagedCrawler` 把**每一页缓存在磁盘**，重跑时从第一个缺失页继续：

```
data/discos-cache/objects/000001.json … 000937.json
```

中断的代价是一页，而不是整份。这也是 `--loop` 能安全运行的前提。

> 另一个坑：DISCOSweb 的 `links.next` 有时会**重复当前页号**。
> 初版信任它，结果 2 分钟内把第 1 页拉了 120 次。现在页号由客户端自己递增，
> 只用 link 的路径与过滤条件。

```bash
npm run sources:download -- --only discos-objects --force
SPACE_SAFETY_DISCOS_CONCURRENCY=6 npm run sources:download -- --only discos-objects
```

## 0.3 全量下载与历史归档

25 个端点、全量约 573 MB，按各自更新频率定时抓取：

```bash
npm run sources:download -- --list        # 列出 25 个端点与周期
npm run sources:download                 # 只下到期的
npm run sources:download -- --force      # 全部
npm run sources:download -- --loop       # 常驻，每 5 分钟检查一次
```

归档布局（保留历史以便监控上游篡改）：

```
data/archive/<endpoint>/<YYYY-MM-DD>/<HHmmss>-<sha256前12>.<ext>
```

保留策略：7 天内全留；90 天内每天首尾各一；更早每月一份。
**最新一份永不删除**。内容未变时不重写文件（哈希比对）。

## 0.4 Spacebook 登录（Auth0）

Spacebook 用 Auth0。实测鉴权边界：

| 端点 | 匿名 | 说明 |
|---|---|---|
| `/api/entity/tle`、`omm/json`、`satcat`、`satcat/supplemental` | ✅ 200 | 目录数据，无需登录 |
| `/api/spaceweather/*`、`/api/eop/*` | ✅ 200 | 环境数据 |
| `/api/Scene`、`/api/Model`、`/api/UserEphemeris` | ❌ 401 | 需 access token |

**为什么不能直接用账密**：该 Auth0 公共客户端只允许 `authorization_code`。
实测 `password` 与 `device_code` 均返回
`403 unauthorized_client: Grant type not allowed`，`client_credentials` 返回 401。

所以流程是**一次性浏览器授权**，之后用 refresh token 自动续期：

```bash
npm run spacebook:login                  # 打印授权链接
npm run spacebook:login -- --code '<回调地址>' --verifier <v>
npm run spacebook:login -- --refresh    # 之后自动续期
npm run spacebook:login -- --status     # 查看缓存状态（不泄露 token）
```

Token 存 `data/.spacebook-token.json`（已 gitignore，权限 0600），
代码见 `src/lib/sources/spacebook-auth.ts`。

**当前状态**：目录类数据已全部匿名入库；需要登录的三个端点尚未接入，
等待完成一次浏览器授权。

## 1. Starlink OCM 星历（推荐）★

信息最完整，含**显式机动计划**。

| 项目 | 值 |
|---|---|
| URL | `https://www.starlink.com/public-files/ephemerides/<OBJECT_NAME>.txt` |
| 格式 | CCSDS OCM 3.0（KVN） |
| 参考系 | **ITRF2000**（系统原生帧），`COV_REF_FRAME = ITRF2000`，LTM |
| 覆盖 | **7 天** |
| 步长 | 60 秒 |
| 规模 | 10081 个状态点，约 5 MB |
| 解析耗时 | **118 ms** |
| 协方差 | 每个历元一个 6×6，与轨迹 1:1 |

### 实测样例（STARLINK-35000，NORAD 65278）

```
轨迹:    ITRF2000, CARTPV, [km,km,km,km/s,km/s,km/s]
历元:    2026-10-26T08:45:42Z → 2026-11-02T08:45:42Z
协方差:  ITRF2000, LTM, 10081 个
机动:    2 个（NTW_ROTATING, PLANNED, CONTINUOUS）
  #0  2026-10-26T15:14:46Z  239.5 s  Z 轴 3.14e-4 m/s²  |Δv|≈0.075 m/s
  #1  2026-10-27T14:44:17Z  238.4 s  Z 轴 3.14e-4 m/s²  |Δv|≈0.075 m/s
```

### 文件结构

```
CCSDS_OCM_VERS = 3.0
COMMENT TIME_LAST_OBSERVATION_GPS_NS = 1477039891416615771
CREATION_DATE = ...
ORIGINATOR = SPACEX/USA
MESSAGE_ID = STARLINK-35000_1793004342

META_START
OBJECT_NAME / OBJECT_DESIGNATOR / OPERATOR / TIME_SYSTEM / EPOCH_TZERO / START_TIME / STOP_TIME
META_STOP

TRAJ_START
CENTER_NAME = EARTH
TRAJ_REF_FRAME = ITRF2000
TRAJ_TYPE = CARTPV
TRAJ_UNITS = [km,km,km,km/s,km/s,km/s]
<10081 行: ISO 时间 + 位置 + 速度>
TRAJ_STOP

COV_START
COV_REF_FRAME = ITRF2000
COV_TYPE = CARTPV
COV_ORDERING = LTM
<10081 行: ISO 时间 + 21 个下三角值>
COV_STOP

MAN_START                       <- 可重复
MAN_ID / MAN_BASIS / MAN_DEVICE_ID / MAN_REF_FRAME / DC_TYPE
MAN_COMPOSITION = TIME_ABSOLUTE, MAN_DURA, ACC_X, ACC_Y, ACC_Z
<一行: 绝对时间 + 持续秒 + 三轴加速度>
MAN_STOP
```

**关键差异**：轨迹与协方差在**独立段**中，需按历元配对（`mergeOcmCovariance`）。

## 2. Starlink Modified ITC（全星座清单）

| 项目 | 值 |
|---|---|
| 清单 | `https://www.starlink.com/public-files/ephemerides/MANIFEST.txt` |
| 文件 | `https://www.starlink.com/public-files/ephemerides/<清单文件名>` |
| 卫星数 | **11163**（实测，名称全唯一） |
| 格式 | Modified ITC（`UVW` 协方差） |
| 参考系 | 位置/速度 **EME2000**，协方差 UVW |
| 覆盖 | 3 天 |
| 步长 | 60 秒 |
| 规模 | 4321 个状态点，约 2 MB，解析 77 ms |
| 更新 | 约 8 小时 |

文件名约定：

```
MEME_<seq>_<OBJECT_NAME>_<NORAD_ID>_<Status>_<epoch>_UNCLASSIFIED.txt
```

**易错点**：时间戳是 `yyyyDOYhhmmss.sss`，**13 位整数**加小数：

```
2026299005442.000  →  2026-10-26T00:54:42Z
 └2026┘└299┘└005442┘
  年    年内天数 时分秒
```

## 两种格式的取舍

| 维度 | OCM | Modified ITC |
|---|---|---|
| 覆盖范围 | **需按卫星名逐个猜** | **全星座 11163 颗**（清单） |
| 预测期 | **7 天** | 3 天 |
| 参考系 | **ITRF2000**（原生帧，免转换） | EME2000 |
| 机动计划 | **✅ 显式** | ❌ |
| 体积 | 5 MB / 颗 | 2 MB / 颗 |
| 适用 | 深度筛查单个目标、机动感知 | 全星座规模压测 |

**建议**：用 ITC 做全星座覆盖与压测，用 OCM 对被筛查的高风险目标做精细分析。

## 3. 坐标变换（必需）

ITRF2000 是**地固系**，直接算轨道根数会得到错误结果（实测倾角偏差约 1°，
半长轴偏差约 **124 km**）。必须先转到惯性系：

```ts
import { itrfStateToJ2000, itrfCovToJ2000 } from "@/lib/orbit/frames-rigorous";

const eci = itrfStateToJ2000(state.position, state.velocity, state.ms);
const cov = itrfCovToJ2000(state.covariance, state.ms);
```

实现的是 IAU-76/FK5 完整链路：

```
ITRF → 极移 → R3(GMST) → 章动 → 岁差 → J2000
```

验证结果（真实 7 天弧段）：

| 检查项 | 结果 |
|---|---|
| 旋转矩阵正交性 `‖MMᵀ−I‖` | 4.4e-16 |
| 行列式 | 1.0000000000 |
| 协方差迹守恒 | 相对误差 **9.9e-16** |
| 半长轴稳定性（7 天） | 450.7 – 474.3 km（漂移 23.6 km） |
| 倾角稳定性 | 97.13 – 97.44°（漂移 0.31°） |

> **注意**：`|h|`（角动量模）在 ITRF 与 ECI 之间**不守恒**——ITRF 速度是
> 地固系导数，含框架旋转项。不要用它做正确性判据。真正的判据是
> 半长轴在整段弧上的稳定性。

## 关于 STARLINK-35000 的倾角

实测 ITC 与 OCM 两份数据的轨道特征**均正确**，分别对应官方壳层表：

| 数据 | 平均 SMA 高度 | 倾角 | 命中壳层 |
|---|---|---|---|
| ITC `STARLINK-38128` | **472.5 km** | **70.15°** | V1+V2 宽带 70° |
| OCM `STARLINK-35000` | **462.5 km** | **97.28°** | V1+V2 宽带 97.3° |

官方壳层表（`constellation_altitudes.md`）：

| 壳层 | 平均 SMA 高度 | 倾角 |
|---|---|---|
| V1+V2 宽带 | 485 km | 43° |
| | **472.5 km** | **70°** |
| | **462.5 km** | **97.3°** |
| | 463 km | 53° |
| V1 DTC | 360 km | 53° |
| | 358.5 km | 43° |

这已固化为 `tests/shells.test.ts`——比“数值看起来合理”强得多的验收标准，
因为它把厂商自己的文档与我们的解析/变换链路对上了。

同时该测试锁住了坐标变换的必要性：**不做 ITRF→J2000 变换**会算出
`i=99.13°/sma=593 km`，匹配不到任何壳层（score=28.8）。

### 两个容易踩的坑（已排除）

1. **manifest 文件名中的数字不是 NORAD ID**。
   `MEME_100001_STARLINK-38128_2990054_...` 里的 `2990054` 是内部序号，
   11163 条记录只有 201 个不同值。与 OCM 的 `OBJECT_DESIGNATOR = 100001`
   对应的才是真实标识（左侧的 `100001`）。
2. **ITC 文件内没有 `OBJECT_NAME` 字段**，卫星身份只来自文件名。


## 4. Spacebook / COMSPOC —— 全目录身份层 ★

spacebook.com 的前端是 Cesium SPA，但**数据全部来自同域的普通 HTTP 端点**，
直接抓 JSON/CSV/KVN 即可，不需要浏览器。

| 端点 | 格式 | 体积 | 用途 |
|---|---|---|---|
| `/api/Entity/xp-tle` | TLE（无名称行） | 4.2 MB | 全部在轨目标根数 |
| `/api/entity/omm/json` | CCSDS OMM | 30 MB | 同轨道 + 名称 + 目录字段 |
| `/api/entity/satcat` | JSON 数组 | 21 MB | 历史全目录 72 310 条 |
| `/api/spaceweather/full` | CCSDS KVN | 3.5 MB | F10.7 / Ap（阻力） |
| `/api/eop/full` | CCSDS KVN | 2.5 MB | 极移、UT1-UTC |

### 实测规模（2026-10-29）

| 项目 | 值 |
|---|---|
| XP-TLE 记录 | **29 668**（解析 0 错误，321 ms） |
| OMM 记录 | 32 810（含 11 161 颗 Starlink） |
| SATCAT 记录 | 72 310 |
| XP-TLE 含名称 | **0**（两行格式，没有第三行） |
| 入库耗时 | 29 566 个对象 **1.5 s**（单事务） |

### 两个必须知道的行为

1. **所有 query 参数都被忽略。** `?noradId=`、`?limit=`、`?format=` 一律返回
   完全相同的全量 body（实测恒为 4 153 520 字节）。所以没有单对象接口，
   也没有分页——每次刷新都是全量下载 + 本地过滤。
2. **会静默截断。** 连接提前关闭时 `fetch` 仍然成功，而**截断的 TLE 会解析成
   更小的目录且零报错**。因此 `SpacebookClient.verify` 同时检查字节下限、
   首字节不是 HTML、以及尾部停在记录边界；解析结果低于 20 000 条直接拒收。

### 身份解析优先级

XP-TLE 不带名称，因此名称按 `NORAD → 名称` 从两个源合并：

```
OMM OBJECT_NAME  >  SATCAT name  >  NORAD-<id>
```

OMM 优先是因为它由运营方发布，而 SATCAT 有时仍是发射代号的占位名。

### 物理参数

SATCAT 给的是 RCS **分级**而不是半径，映射为保守的硬体半径（宁可偏大，
漏报比误报更糟）：

| RCS 等级 | 硬体半径 |
|---|---|
| LARGE | 5.0 m |
| MEDIUM | 1.5 m |
| SMALL | 0.5 m |
| 未知 | 1.5 m |

机动能力按类型推断：只有 `PAYLOAD` 视为可机动，`DEBRIS` / `ROCKET BODY` 一律否。

### 入库方式

```bash
npm run spacebook:refresh                 # 下载 + 校验 + 解析 + 入库
npm run spacebook:refresh -- --no-download  # 用当天已下好的快照
npm run spacebook:refresh -- --max-age 7    # 丢弃超过 7 天的根数
```

结果写三处：`satcat`（全量替换）、`objects`（operator = `catalog`）、
`trajectories`（`state_source = 'tle'`，`point_count = 1`，`has_covariance = 0`）。

**Starlink 不会被覆盖**：它们的 OCM 轨迹是另一行（`state_source =
'operator_ephemeris'`），TLE 只是并列的第二个来源。这正是「两套数据都入库」
的落点，也让筛查端能按 `source-policy` 选择用哪一套。

### 为什么 TLE 只做身份与初筛

SGP4 不带协方差，算不出 Pc。所以 XP-TLE 的角色是：

- 给 `/objects` 提供 NORAD 编号与名称；
- 给非 Starlink 目标提供初筛轨迹；
- 与 OCM 在同历元交叉校验（偏差大 = 有一方过期）。

交会筛查的 Pc 仍然只来自 OCM 的 6×6 协方差。

---

## 代码入口

```ts
// OCM
import { parseOcm, mergeOcmCovariance } from "@/lib/orbit/ocm";
const ocm = parseOcm(raw);
const states = mergeOcmCovariance(ocm);

// Modified ITC
import { fetchManifest, fetchEphemeris } from "@/lib/sources/starlink-public";
const manifest = await fetchManifest();     // 11163 条
const eph = await fetchEphemeris(manifest[0]);

// Spacebook：全目录身份层
import { SpacebookClient } from "@/lib/sources/spacebook";
const sb = new SpacebookClient();            // 默认读 SPACE_SAFETY_PROXY
const snap = await sb.fetch("xp-tle");       // 下载 + 校验，返回 path/bytes/ok

import { TleCatalogueIngest, loadSatcat } from "@/lib/sources/spacebook-ingest";
const satcat = loadSatcat(sqlite);           // Map<noradId, SatcatMeta>
new TleCatalogueIngest().run(sqlite, tles, satcat, names);  // 单事务，29k 条约 1.5 s
```

测试中有真实数据样本：`tests/fixtures/ocm-*.txt`、
以及 `tests/ephemeris.test.ts` 内嵌的 ITC 原文。

---

## Space-Track（TLE / GP 目录）

**地址**：`https://www.space-track.org/basicspacedata/query/class/...`
**认证**：账号密码，登录后持 cookie。**需要凭据**。

这是**唯一**能拿到 NORAD 目录编号的公开来源。SpaceX 的星历里没有这个编号——
manifest 文件名中的数字是投送序号，不是 NORAD id。

### 凭据

放在 `.env.local`（已在 `.gitignore` 中）：

```
SPACE_SAFETY_SPACETRACK_USER=<email>
SPACE_SAFETY_SPACETRACK_PASS=<password>
```

脚本会自动读取 `.env.local`（`scripts/env.ts`）；Next.js 应用原生支持。
没有凭据时应用照常运行，只是目录相关功能返回 503 并说明原因。

### 用到的两个类

| 类 | 用途 |
|---|---|
| `gp` | 最新根数，`format/3le` 带名称 |
| `satcat` | 对象身份：类型、发射日期、**是否再入**、大致轨道 |

两者都要：`gp` 给轨道，`satcat` 给身份和再入状态。只看 `gp` 会把已再入的对象
和现役对象混为一谈。

### 查询语法上的坑

| 写法 | 结果 |
|---|---|
| `OBJECT_NAME/STARLINK-38128` | **空** |
| `OBJECT_NAME/~~STARLINK-38128` | 正常返回（`~~` = contains） |
| `NORAD_CAT_ID/44713` | 正常 |

### Alpha-5 编号

目录超过 99 999 个对象后启用字母前缀。`A1193` = 101193，A=10…Z=33，跳过 I 和 O。
解析器支持双向转换（`parseCatalogueNumber` / `formatCatalogueNumber`）。

### 代码入口

```ts
import { fetchGp, fetchGpByNorad, fetchSatCat } from "@/lib/sources/space-track";
import { resolveNorad } from "@/lib/sources/norad";
import { parseTleFile } from "@/lib/orbit/tle";
import { propagateTle } from "@/lib/orbit/sgp4";

// 目录 + NORAD id 反查
const r = await resolveNorad("STARLINK-38128", trajectoryStates);

// 按编号取根数并传播
const { tle } = await fetchGpByNorad(100001);
const states = propagateTle(tle!, { spanHours: 24, stepSeconds: 60 });
```

回填所有对象的 NORAD id：

```
npm run norad:backfill -- --dry-run   # 预演
npm run norad:backfill                # 写入
```

### OCM vs ITC：两者都存

同一个目录下两种格式，**都要入库**：

| | OCM（直链） | Modified ITC（manifest） |
|---|---|---|
| NORAD 编号 | **有**（`OBJECT_DESIGNATOR`） | 无 |
| 协方差 | **有**（`COV_START` 段，每条状态 36 个值） | 有（UVW 行） |
| 机动计划 | **有**（`MAN_*`） | 无 |
| 跨度 | 7 天 | 3 天 |
| 状态数 | ~10081 | ~4321 |
| 坐标系 | ITRF2000 | EME2000 |

> **一个曾经的误判**：早期我判断 OCM 不带协方差，理由是 grep `COV_START` 在
> 截断的下载副本里没找到。完整文件里 `COV_START` 就在 `TRAJ_STOP` 之后，
> 10081 条状态全部带 36 元协方差，还有 3 条机动计划。
> **OCM 在每一项上都优于或等于 ITC。**

那为什么还留 ITC？因为它是同一轨道的**第二个独立样本**——预测精度报告需要
两份不同的数据来测量漂移。而且部署环境可能只有其中一种。

### 入库方式

`npm run ingest:starlink -- --objects A,B` 会：

1. 从 OCM 头读出 `OBJECT_DESIGNATOR` 作为 NORAD 编号；
2. 两条轨迹分别写入 `trajectories`，`file_format` 分别记 `ocm` / `itc`；
3. 用 `companion_id` 互相指向；
4. `has_covariance` 由实际解析结果决定，不是猜的。

内容哈希去重：文件没变就不重复写，避免每天涨几 MB。

### 为什么 Starlink 不能用 TLE

见 `docs/ARCHITECTURE.md` 的「轨迹数据源分层」。简言之：TLE 是拟合值，
厂商发布的传播轨迹是更好的输入；而且用错不会有明显症状。

### 精度边界

SGP4 是 TLE 的**定义性**传播器——根数就是按 SGP4 拟合的，换模型不是"更精确"而是
另一个轨道。但它不是高精度模型：无日月摄动、阻力只有 B* 一项、误差随根数年龄增长。

因此本平台把 TLE 定位为**目录身份**来源，轨迹仍以运营方星历（OCM/OEM）为准。
SGP4 不带协方差，所以用它算出的 CDM 的 Pc 一律为 NULL——这与官方行为一致。
