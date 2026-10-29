# 数据源

> 当前聚焦 **Starlink**。`spacebook.com` 是 Cesium 三维 SPA（需浏览器渲染，
> 非普通 HTTP 站点），尚未接入，见文末「待办」。

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


## 待办：spacebook.com

- 站点使用 **Cesium** 做三维渲染，是前端 SPA；`curl` 任意路径返回 404，
  必须用真实浏览器渲染。
- 需要先确定：代理配置方式、可抓取范围、数据许可。
- 目标是补齐**非 Starlink 目标**（其他星座、碎片）及其物理参数，
  以成为碰撞概率计算的真实「次对象」来源。

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
