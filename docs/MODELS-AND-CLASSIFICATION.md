# 3D 模型库与多维分类

实测时间：2026-10-30

---

## 一、3D 模型库

### 1.1 各来源的真实情况

| 来源 | 模型数 | 格式 | 结论 |
|---|---|---|---|
| **nasa/NASA-3D-Resources**（GitHub） | **257** | `.glb` + 预览 PNG | ✅ 已全量下载 |
| Spacebook（订阅） | 42 | `.glb` | ✅ 已接入 |
| **ESA** | **0** | — | ❌ 无 3D 模型库 |
| **Starlink / SpaceX** | **0** | — | ❌ 从未公开卫星模型 |
| science.nasa.gov/3d-resources | 同上 | — | 是 NASA 仓库的网页前端 |

**ESA 在 GitHub 上没有 3D 模型组织，官网也无 `/3D_models` 页面（404）。
SpaceX 从未发布 Starlink 卫星网格模型。**

### 1.2 NASA 仓库实测

- 仓库总量 **5.2 GB**，但其中可用的 `.glb` 只有 **609 MB / 257 个**
- 其余是 `.blend`、`.max`、`.fbx` 源文件与 3D 打印文件
- 覆盖 **186 个不同航天器**（同型号有多个变体，如 `Aqua (A)/(B)/(C)`）
- 全部带预览图
- 全部可商用（NASA 公开资源）

**下载量 582 MB 落地，零失败。**

### 1.3 为什么不用压缩包

codeload 生成的 tarball 是流式的，**不返回 `Content-Length`**，无法分段并发下载；
单连接实测跑几十分钟未完成。

改用 **GitHub git tree API**：
```
GET /repos/nasa/NASA-3D-Resources/git/trees/master?recursive=1
```
**一次调用 3 秒返回全部 1,583 个条目**（含路径与大小，未截断），
然后按清单并发下载 257 个 `.glb`。

### 1.4 为什么不用 GitHub contents API

第一版按目录逐个调用 contents API，**匿名限流 60 次/小时**，227 个目录直接耗尽，
168 个目录静默失败——这是必须避免的「看起来成功实际没数据」问题。

### 1.5 存储（全部本地，无运行时网络依赖）

| 项 | 位置 | 大小 |
|---|---|---|
| 元数据 | `model_asset` 表 | 257 + 42 行 |
| 模型本体 | `data/models/nasa/` | **582 MB** |
| 预览图 | `data/models/previews/` | **199 MB** |

**合计 780 MB，全部落盘。** 页面渲染时不请求 GitHub：
实测 263 个资源链接全部指向 `/models/*` 本地路径，零外部引用。

文件不放进 `public/`，因为它们是**下载产物而非源码**，不该进版本库：
`/models/*` 由 `next.config.ts` rewrite 到 `/api/models/[...path]`，
路由内做路径穿越校验，并按扩展名返回正确 MIME（`.glb` → `model/gltf-binary`，
`.png` → `image/png`）。

**离线可用**：下载完成后，断网也能浏览模型库与渲染三维模型。

---

## 二、多维度分类

### 2.1 为什么要有这张表

`master_object.object_class` 只回答「载荷/碎片/火箭体」。
实际要问的是四件独立的事：**哪个国家、哪个星座、干什么用、什么轨道**。

`object_classification` 表：

| 维度 | 来源 | 覆盖 | 说明 |
|---|---|---|---|
| 国家 | Space-Track `COUNTRY` | 71,198 | ISO 风格代码（`US` `PRC` `CIS`） |
| 星座 | 由名称推导 | 见下 | 26 条规则，最长前缀优先 |
| 所营方 | 随星座推导 | — | `SpaceX`、`Eutelsat OneWeb`… |
| 用途 | KeepTrack `purpose` | 11,377 | 唯一有自由文本用途的来源 |
| 轨道类型 | **由远/近地点计算** | 69,086 | 见 2.2 |
| 平台型号 | GCAT `bus` | 38,261 | |

### 2.2 轨道类型为什么是算出来的

GCAT 的 `orbit_type` 把**轨道类型和细分后缀混在一起**：
`LLEO/I`、`LEO/S`、`GTO`… 直接用等于拿第三方某个时间点的快照给卫星分类。

有远地点和近地点时按定义计算：

```
GEO    近地点 > 35,000 km
MEO    2,000 ≤ 近地点 < 35,000 km
LEO    远地点 < 2,000 km
HEO    近地点 < 2,000 ≤ 远地点
```

判定依据：**computed 69,086 / stated 1,681 / unknown 1,204**。

> 注意：VANGUARD 1（远地点 3,819 / 近地点 651）被判为 **HEO**，这是对的。
> 它是高椭圆轨道，不是分类错误。

### 2.3 分类结果（71,971 个对象）

**按轨道类型**

| 类型 | 数量 |
|---|---|
| LEO | 63,982 |
| HEO | 3,288 |
| GEO | 1,787 |
| MEO | 1,710 |
| UNKNOWN | 1,204 |

**按国家（前 8）**

| 国家 | 数量 |
|---|---|
| US | 29,487 |
| CIS | 25,239 |
| PRC | 9,439 |
| FR | 1,484 |
| JPN | 927 |
| IND | 767 |
| UK | 763 |
| ESA | 189 |

**按星座（前 10）**

| 星座 | 数量 | 运营方 |
|---|---|---|
| Cosmos | 13,358 | Roscosmos |
| Starlink | 12,972 | SpaceX |
| Iridium | 859 | Iridium |
| Planet | 692 | Planet Labs |
| NOAA | 671 | NOAA |
| OneWeb | 656 | Eutelsat OneWeb |
| Yaogan | 285 | CNSA |
| Spire | 255 | Spire Global |
| Qianfan | 248 | SpaceSail |
| Guowang | 231 | China SatNet |

**按用途**

| 用途 | 数量 |
|---|---|
| communication | 8,629 |
| earth-observation | 672 |
| technology | 444 |
| navigation | 388 |
| military | 364 |
| meteorology | 245 |
| science | 212 |

### 2.4 已知局限

- **用途覆盖低（11,377 / 71,971 = 15.8%）**。只有 KeepTrack 提供自由文本用途，
  其余源没有。碎片、火箭体本身也没有用途。
- **星座靠名称匹配**，未列入规则的星座（如新发射的中国星座）会显示为空。
- **1,204 个对象无法判定轨道**，因其无远/近地点也无 GCAT 轨道类型。

---

## 三、命令

```bash
npm run models:sync              # 抓模型清单（3 秒）
npm run models:sync --download   # 并下载 257 个 .glb（约 1 分钟）
npm run catalogue:classify       # 生成多维分类
```

## 四、页面

- `/models` — 三维模型库，网格展示预览图，可下载
- `/catalogue` — 列表新增「星座」「轨道」两列
