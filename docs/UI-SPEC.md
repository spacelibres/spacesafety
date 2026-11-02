# 官方 UI 视觉与布局规格

依据：`docs/reference-screenshots/` 中 27 张官方界面截图（清单见该目录 `MANIFEST.md`）。
这些是重建 UI 时的**强制参考**——布局、信息层级、控件形态应与之对齐。

## 全局骨架

```mermaid
graph TD
    A["左侧栏 184px 固定"] --> B["顶部面包屑 + 全局 UUID"]
    B --> C["页面标题 + 操作按钮"]
    C --> D["元信息横条"]
    D --> E["主内容区"]
```

### 左侧栏

- 宽度约 **184 px**，深色（近 `#0a0a0a`），与主内容区之间有细分隔线。
- 顶部：品牌字标 `SPACE SAFETY`（全大写、加宽字距）。
- 环境横幅：staging 时为**橙色实心条**，文字 `STAGING`；
  production 不显示。这是最重要的环境提示，必须复刻。
- 其下：`YYYY-MM-DD HH:mm:ss UTC` 实时时钟，等宽字体。
- 搜索框：占位符 `Search (/)`，快捷键 `/`。
- 导航项（图标 + 文本，选中态为白色胶囊背景 + 深色文字）：

  | 项 | 说明 |
  |---|---|
  | Home | 总览 |
  | Docs | 文档 |
  | Operators | 运营方列表 |
  | Objects | 对象（卫星）列表 |
  | Trajectories | 轨迹列表 |
  | Conjunctions | 交会事件列表 |
  | Users | 用户（仅管理员） |
  | Keys | API 凭证 |
  | Feedback | 反馈 |

### 顶栏

- 左侧：面包屑（图标 + 当前层级，如 `Operators`）。
- 右侧：当前页面实体的 **完整 UUID**，等宽字体、低对比度灰色。

### 页面标题区

- 大号标题：列表页为类名（`SpaceX`），详情页为 `实体类型 + UUID 前 8 位`
  （如 `Conjunction d0ed43cd`、`Trajectory 013a0648`）。
- 右侧主操作按钮：`Edit`（带下拉箭头）、`Create object`、`Download ▾`。

## 元信息横条

详情页标题下方一行，字段之间用竖线分隔，**标签在上（灰、小号）、值在下（等宽、白色）**：

- 交会页：`Collision Probability` · `Initial TCA (UTC)` · `Created At (UTC)` · `Updated At (UTC)`
- 轨迹页：`Screened Status`（胶囊） · `Screened At (UTC)` · `Created At (UTC)` · `Uploaded At (UTC)`

## 数据表

- 表头：小号大写灰字，左侧对齐，列可排序（`Name ↕`）。
- 行：细下边框，hover 高亮。
- 布尔值渲染为**胶囊徽章**：`true` 绿色描边，`false` 红色描边。
- 计数提示在表格标题右侧，形如 `Showing 50 of >10000 objects`（灰色小字）。

### 筛选栏

- 左侧漏斗图标按钮，右侧齿轮（列设置）按钮。
- 每个筛选项为「字段名 + 操作符下拉 + 值输入」三段式：
  `Alive [equals ▾] [true ▾]`、`Name [contains ▾] [_]`、`NORAD Id [equals ▾] [_]`。

## 键值信息卡

两列表格形态：左列深灰底、固定宽度；右列为值。用于对象属性：

| 交会页 Object 1/2 | 轨迹页 |
|---|---|
| Operator Name | Operator |
| Object Name | Object |
| Object NORAD Id | Object NORAD Id |
| Object Alive | State Source（胶囊） |
| Object Maneuverable | Type（胶囊） |
| Object Hard Body Radius (m) | Start At (UTC) / End At (UTC) |

## 图表规范

统一深色主题：背景透明、网格线极淡、坐标轴标签灰色小字。

| 图表 | 位置 | 关键要素 |
|---|---|---|
| **Mean Orbital Elements** | 轨迹页右侧 | 折线 + 散点；下方切换 `SMA / Inc / Ecc / RAAN / AoP / MA` |
| **Prediction Consistency** | 交会页双栏 | R 方向误差 + 标准差竖线；图例区分 `operator_ephemeris`（橙）与 `spacex_optical`（蓝）；X 轴 `Creation Time (hrs Tgo)` 反向 |
| **Prediction Error** | 对象页 | 绿线 + 1σ/3σ 色带（绿/红）；Y 轴 `Position Error (m)` |
| **Prediction Error CDF** | 对象页 | 理想以 0 为中心 |
| **Mahalanobis Distance** | 对象页 | 单维马氏距离 |
| **Mahalanobis CDF** | 对象页 | 实测 vs χ²(k=1) 虚线基准 |

### 图表控件行（对象页「Prediction Accuracy」）

`Prediction Source` / `Reference Source` / `Prediction Horizon`（如 `3h`）/
`Axis`（`Radial` / `InTrack` / `CrossTrack`）/ `From`（`now-7d`）/ `To`（`now`）。

### 交会页图表控件行

`Error:` `R | T | N | Total | m | Mahal.` · `Time:` `Observation | Creation | UTC | hrs Tgo`
（当前选中项为白色胶囊/浅底）。

## CDM 表（轨迹页底部）

列：`Id` · `Conjunction` · `Is Active`（胶囊） · `Collision Probability` ·
`TCA (UTC)` · `Object 1 Name` · `Trajectory 1 State Source`（彩色胶囊） ·
`Object 2 Name` · `Trajectory 2 State Source`（彩色胶囊） · `Created At (UTC)` ·
`File`（`json` / `kvn` 两个下载图标）。

**State Source 配色**：`operator_ephemeris` 橙色描边，`spacex_optical` 蓝色描边。

## 配色

| 用途 | 值 |
|---|---|
| 页面背景 | 近黑 `#0a0a0a` |
| 卡片/表格背景 | 比背景略亮 |
| 卡片左边标签列 | 中灰 `#2a2a2a` 左右 |
| 主文本 | 近白 |
| 次级文本 | 灰 `#9a9a9a` |
| 强调/链接 | 蓝色 |
| 成功 true | 绿 |
| 失败 false / 高风险 | 红 |
| Staging 横幅 | 橙 `#f5a623` 左右 |
| operator_ephemeris | 橙 |
| spacex_optical | 蓝 |
| 图表主数据 | 亮绿 / 橙 / 蓝（按图） |

字体：界面无衬线；**所有 UUID、时间、数值、表标识一律等宽字体**。

## 待补充

- 截图未覆盖：`Home` 总览页、`Objects` 列表页、`Keys` 页、登录/凭证页。
  这些按现有模式（左侧栏 + 标题 + 筛选栏 + 表格）推导实现。
- 3D 轨道视图官方未公开截图，属我方扩展能力，不受此规格约束。

---

## 对齐状态（2026-11-02 实测）

`docs/UI-SPEC.md` 里的条目逐项核对过，结论如下。核对方式一律是真实浏览器取证
（`getComputedStyle` / DOM 查询 / URL 参数对比），不是读代码推断。

| 规格条目 | 状态 | 取证 |
|---|---|---|
| 左侧栏固定宽度 + 品牌字标 | **已对齐（用 VI 矢量母版，非字标）** | 272 px；品牌 240 px 内联 SVG（VI 导航下限 240） |
| 环境横幅（staging） | 已对齐 | `.sidebar-env` 渲染 `staging` |
| UTC 实时时钟 | 已对齐 | `.sidebar-clock` |
| 搜索框 `Search (/)` + `/` 快捷键 | 已对齐 | 侧栏搜索框 |
| 导航 9 项 | 已对齐并超出（14 项） | `.nav-icon` 计数 14；分组可展开 |
| 顶栏：面包屑 + 完整 UUID | 已对齐 | 四个详情页传 `entityId`，顶栏右侧等宽 UUID |
| 详情页标题 `类型 + UUID 前 8 位` | 已对齐 | `conjunction.titleWithId` / `trajectory.titleWithId` |
| 元信息横条（标签在上、值在下） | 已对齐 | `.meta-strip`，交会页与轨迹页均渲染 |
| 表头可排序 `Name ↕` | **本轮补齐** | 四个列表页共 20 个 `.th-sort`；`?sort=noradId&dir=desc` 实测改变首行 |
| 筛选栏三段式（字段 + 操作符 + 值） | **本轮补齐（之前是装饰）** | `/objects`、`/trajectories` 的 `<select>` 之前无 `name`、无 form，改完实测缩小结果集 |
| 计数提示 `Showing N of M` | 已对齐 | `共 42,427 个物体，显示 200 个` |
| 布尔值胶囊徽章 | 已对齐 | `.chip.true` / `.chip.false` |
| 键值信息卡（左列深灰） | 已对齐 | `.kv` + `.k` / `.v-mono` |
| 图表：Mean Orbital Elements（六要素切换） | 已对齐 | `ElementsChart`，SMA/Inc/Ecc/RAAN/AoP/MA |
| 图表：Prediction Error / CDF / Mahalanobis | 已对齐 | `AccuracyPanels` 挂在对象详情页 |
| 交会页 Prediction Consistency（R/T/N 双栏） | **部分**：本部署用 `PcHistoryChart`（Pc 随时间）替代 | 见下方"未对齐" |
| CDM 表（json/kvn 下载图标 + state source 胶囊） | 已对齐 | 轨迹页与交会页均有两个下载链接 |
| 等宽字体用于 UUID/时间/数值 | 已对齐 | `.mono-sm` / `.v-mono` 贯穿 |

### 未对齐（记录在案）

- **交会详情页的 Prediction Consistency 图**：官方是"R/T/N 方向误差随时间"的双栏图，
  我们画的是 Pc 随 CDM 版本的历史。要画官方那张，需要为每条 CDM 在其创建时刻
  对两端轨迹做一次误差复算——那是计算工作量，不是画图工作量，单列在 `docs/GAPS.md`。
- **列设置（齿轮）**：官方筛选栏右侧有列显隐设置，我们未实现；当前列固定。

---

## 前端细节审查（2026-11-02）

在这一轮之前，上面那张表只覆盖了"页面长什么样"。真正的问题在**页面之外**：
状态页、标题、可用性、以及"看着能点其实不能"的控件。

| 发现 | 证据 | 处置 |
|---|---|---|
| 所有页面共用一个 `<title>` | 16 个页面全部输出 `<title>太空之眼</title>` | 每页 `generateMetadata`，详情页用「类型 + uuid 前 8 位」；docs 页用页面标题 |
| 没有 `not-found.tsx` | `/objects/<不存在>` 渲染 Next 的英文默认页 | 新增；**正文必须是客户端组件**（见下） |
| 没有 `error.tsx` | 抛错→Next 默认白屏，无 digest 可报 | 新增，显示 digest + 重试 + 回总览 |
| 没有 `loading.tsx` | 点导航后旧页面停留到新页面返回，看起来像没响应 | 只在**叶子段**加骨架（见下） |
| 侧栏搜索框是装饰 | 输入 `starlink` 后 URL 不变、无任何反应 | 改成提交到 `/catalogue?q=`；补 `/` 快捷键（Escape 失焦） |
| 键盘焦点不可见 | `.filter-group > input/select` 设了 `outline: none` 且无替代 | 全局 `:focus-visible` 环 + 筛选控件专用规则 |
| 缺跳转正文链接 | 侧栏 14 个链接，键盘用户每页要 Tab 一遍 | 新增 `.skip-link` → `#main-content` |
| `/objects/<id>` 只有前 1000 个能打开 | 详情页用 `listObjects(1000).find()`，表里有 42,427 行 | 新增 `getObjectById()` / `listObjectsByOperator()`；首/中/末位对象实测均 200 |
| `/catalogue?q=` 头部计数错误 | 搜到一个对象仍显示"五源并列 · 72,432"并给出 725 页 | `countWideObjects(filters)` + 「匹配 · 1 / 72,432」 |
| 三个 OMM 编码记录数断言过严 | JSON/KVN 07:08 抓、XML 05:08 抓，中间多了一个 NORAD 26671 | 改为「差值 ≤ 50」并写明原因 |

### 一个值得记住的 Next 陷阱：404 状态 vs 加载骨架

- 加 **根级** `loading.tsx` 后，`notFound()` 全部变成 **HTTP 200**：响应头在错误被发现前就已经
  以 200 冲出去了，`notFound()` 只能改 body。实测 `/objects/<不存在>`、`/conjunctions/<坏 id>`、
  `/catalogue/<坏号>`、`/docs/<坏 slug>` 四条路径从 404 变成 200。
- 所以骨架只挂在**没有动态子路由**的叶子段（browse / statistics / launches / reentry /
  environment / models / keys / users / feedback）。`tests/route-states.test.ts` 会拦住
  「有动态子路由却挂 loading.tsx」的写法。
- 另外：`notFound()` 在动态页里是以 **RSC payload** 送到浏览器的，服务端渲染的 HTML 正文是
  一个 `<div hidden>`。因此 `not-found.tsx` 里**不能用服务端读词典**（`getTranslator()`），
  否则浏览器里是空白页（实测：status 404、正文 0 字符）。文案改由客户端组件
  `RouteMessages.tsx` 提供后正常。
