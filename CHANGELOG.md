# 变更日志

本项目的版本号是**严格递增的补丁版本**：每一次进入版本库的迭代都递增最后一位
（`0.1.0` → `0.1.1` → `0.1.2` …）。版本号同时写在 `package.json` 与对应的 git tag 上，
两者必须一致。

记录规则：

- 每条目写清「为什么改」，而不只是「改了什么」；
- 影响计算结果、剪枝策略或数据格式的改动，必须写明验证方式；
- 已知问题单列，不藏在「修复」里。

---

## [0.1.22] - 2026-10-30

修复 KeepTrack 数据未写入宽表。

### 修复

- **KeepTrack 整列全空**：`loadKeepTrack()` 已实现但**从未被调用**（`const kt = loadKeepTrack()`
  某次批量替换时被覆盖丢掉），宽表 131 列中 `__keeptrack` 全部为空，
  而构建报告却显示 24 039 条——报告统计的是内存中的行，不是写入数据库的值。
  现有实际校验：写入后计数为 0 时直接告警。
- 载入改为绝对可配置路径（`SPACE_SAFETY_DB`），并打印「载入 N 行，其中 M 行有制造商」，
  避免静默读到空库。
- **日期格式不统一**：KeepTrack 返 `1958-03-17T12:15:41.000Z`，其余三源为 `1958-03-17`，
  四源并列时可读性极差。统一截取日期部分。
- 四源表格最后一列「当前采用」被截断（CSS 宽度不够加 ellipsis 生效在错误的列上）。

### 验证

- `keeptrack_object` 34 110 行；宽表 `manufacturer__keeptrack` **24 039**、
  `shape__keeptrack` **21 452**、`mass_kg__keeptrack` **21 441**
- VANGUARD 1（NORAD 5）三源质量交叉验证一致：Spacebook 1.5、DISCOS 1.5、KeepTrack 1.5
- 页面截图确认四源并列正常

### 说明

个别对象在 KeepTrack 中确实无物理数据（如 YAOGAN-40 03C 返回 null/0），
这是源头缺失，不是入库丢失。已用 VANGUARD 1 验证非普遍问题。

---

## [0.1.21] - 2026-10-30

KeepTrack 作为第四个数据源全量本地化，并修掉一处污染 32 410 行的占位值。

### 变更

- **KeepTrack API v4 作为第四源**（`src/lib/sources/keeptrack.ts`）：不再是补充层，
  与 Space-Track / Spacebook / DISCOS 平级，在宽表中占独立一列，可由用户选择。
- **`npm run keeptrack:sync`**：一次请求拉全部 50 539 个对象（24 MB，约 5 s），
  写入 `keeptrack_object` 并归档原始 JSON。全量替换，不做增量合并。
- 宽表扩至 **131 列**、48.3 MB，四源并列。
- 抓取白名单补全：NASA / ESA / CNSA / JAXA / ISRO / NOAA / 美天军 / SpaceX / HawkEye 360 /
  Planet / OneWeb / Spire / ICEYE / BlackSky / FCC / ITU / Gunter's / Wikipedia /
  SpaceNews / LeoLabs / KeepTrack。
- 新增 `robots.txt` 检查；Gunter's 的 `aiRAG: allowed-with-attribution-required`
  在 claim 中写入 `attribution` 字段。

### 修复：Spacebook 占位值污染 32 410 行

实测：**31 879 个碎片**同时具有 `mass=5 kg / HBR=5 m / span=10 m`，为 Spacebook 对
无物理模型对象的默认填充，其中 **13 024 个在轨**。该值被当作实测数据使用。

构建时现将其从 Spacebook 列清除（读作「无值」而不是「5 kg」）。
质量覆盖 71 074 → 38 664，但留下的每一条都是真实数据。

### 实测：KeepTrack 的能力与局限

| 字段 | 覆盖（34 110 条有 NORAD 的记录） |
|---|---|
| name | 99.7% |
| manufacturer | 68.3% |
| shape | 61.0% |
| bus | 59.9% |
| launch_mass | 61.0% |
| span | 61.0% |
| **source_urls（引用出处）** | **0.3%** |

结论：物理字段覆盖可观，但**几乎不提供引用来源**，因此作为第四源并列展示而非默认采用。

另：50 539 条中有 **16 429 条无 NORAD**（KeepTrack 临时编号 `A0000`），已按 COSPAR
归档；这批对象几无物理数据（仅 2 条有 manufacturer）。

### 验证

- `tsc --noEmit` 无错误；`npm run check` 全过；`tests/catalogue` 13 项、`tests/supplement` 18 项全过
- 页面截图核对四源并列显示

---

## [0.1.20] - 2026-10-30

补充数据层：AI 检索结果单独存放，带完整溯源，不直接进编目库。

### 变更

- **`supplement_claim` 表与 `SupplementStore`**（`docs/SUPPLEMENT-LAYER.md`）：
  AI 检索结果入库前强制校验，缺 URL、缺原文摘录、无可定位对象者**直接丢弃**。
- **来源分级**：A（机构/厂商官网/FCC）、B（专业媒体/百科/论文）可入库；
  **C 级在入库时拒绝**，不是存了再过滤。
- **`npm run supplement:candidates`**：筛出可补对象，按发射日期倒序。
- **`tests/supplement.test.ts`**：18 项，覆盖准入规则、分级、审核流程。

### 为什么必须单独一层

编目库每个数字都要能回答「谁说的」。三大源是官方编目，可逐字节复核；
网页检索不是。混在一张表里，就分不清「美国太空军记载」与「某网站说」。
补充值**永不自动成为默认**。

### 实测：真正需要补的只有 1,207 个

| 字段 | 在轨缺口 | 说明 |
|---|---|---|
| 质量 / 硬体半径 | 114 / 115 | 缺口太小，不值得抓取 |
| 形状 | 12,831 | 但 12,546 个是碎片 |
| 制造商 | 10,632 | **其中 9,465 个是碎片** |
| 平台型号 | 13,444 | 同上 |

**碎片没有制造商**，它们来自某次解体，只能追母体。对碎片查「制造商」在物理上就是错的。
排除碎片后，切实可补的在轨对象仅 **1,207 个**（bus 1,081、manufacturer 896、shape 521、mass 78）。

### 已知限制

联网检索需要搜索/模型 API，项目尚未配置（无 `SERPER_API_KEY` 等）。
本版只完成结构与规则、候选筛选，**未执行实际抓取**。

---

## [0.1.19] - 2026-10-30

统一编目页排版，修掉三个真实 bug。

### 排版（用户指出排版混乱）

- **竖排乱码**：详情页面包屑与标题挤在同一 flex 行，被右侧计数挤成每行一字。
  现单独成行（`.crumb`）。
- **“查询”按钮折行**：`.filter-btn` 是为图标设计的 34px 方按钮，文字标签被压成两行。
  新增 `.btn` 类用于文字按钮。
- **列宽失衡**：三源对比表改 `table-layout: fixed`，值列等宽；删掉全部内联 `style`，
  统一用 `globals.css` 中的类。
- 去掉列表页“分歧”列：该列为 0/1 时几乎无信息量，详情页已完整展示。
- 默认语言改为 `zh-CN`。

### 修复

- **NORAD 0 脏行**：DISCOS 有 22 516 条记录无 `satno`（尚未编目的新目标），
  `Number(null)` 得 0，全部塌进同一行无名称记录。构建脚本现跳过无编号行，
  宽表从 71 201 行降为 71 200 行。
- i18n 键重复插入一轮，已去重（6 语言各 1 个）。

### 发现（数据层面）

- **Spacebook 的 `GCAT DecayDate` 不是再入日期**。ISS（25544）该值为
  `1998 Dec 6 2347:02`，实为 ZARYA 舱段发射后分离时刻；Space-Track 正确显示为空（仍在轨）。
  多舱段组合体（ISS、天宫）均有此问题。这正是三源必须并列的理由——只留一个值会误判。
  已记入 `docs/WIDE-CATALOGUE.md`。

### 验证

- `tsc --noEmit` 无错误；`npm run check` 全过
- 无头 Chrome 截图核对 `/catalogue` 与 `/catalogue/44713`、`/catalogue/25544` 三个页面

---

## [0.1.18] - 2026-10-30

编目宽表：三源原值并列一表，由用户选择采用哪个，不由我们裁定。

### 变更

- **`data/catalogue-wide.sqlite`**（`docs/WIDE-CATALOGUE.md`）：71 201 行 × 105 列。
  26 个字段每个 4 列（`__spacetrack` `__spacebook` `__discos` `__chosen`），
  由 `npx tsx tools/build-wide-catalogue.ts` 从三源原始下载直接生成，42.3 MB。
- **`/catalogue` 编目页与 `/catalogue/[norad]` 详情页**：每个字段并排展示三源值，
  标出当前采用哪个，并显示来源分歧数。
- **`PATCH /api/v1/catalogue/choice`**：按对象逐字段更改采用来源。
- 宽表以 **ATTACH** 方式只读挂载（`SPACE_SAFETY_WIDE_DB`），缺失时页面明确提示
  而非静默回退。

### 采用规则（Space-Track 优先）

用户明确：Space-Track 是美国官方基准编目，凡它有值的字段默认采用 Space-Track——
`name` `cospar_id` `object_class` `country` `launch_site` `launch_date` `decay_date`
`inclination` `period` `apogee` `perigee` `rcs_size`。

Space-Track 不提供的 6 个字段只能取自他源：`shape`（DISCOS 唯一）、
`hard_body_radius_m` `ballistic_coefficient` `manufacturer` `bus` `orbit_type`（Spacebook 唯一）。

### 实测发现

- **Space-Track 不发布质量**（71 198 条中 0 条），故 `mass_kg` 只能在
  DISCOS（38 427 条实测）与 Spacebook（71 074 条推导）间选，现为 DISCOS 优先。
- **三源不一致率**：`object_class` 100%（体系不同，非错误）、`name` 97.56%
  （仅大小写差异）、`decay_date` 99.94%（实测 vs 预测）、`inclination` 79.40%
  （GCAT 记发射时值）、**`mass_kg` 仅 0.07%**（两源高度互证）。

### 验证

- `tsc --noEmit` 无错误；`npm run check` 除版本标签外全过
- `tests/catalogue.test.ts` 13 项、`tests/master-merge.test.ts` 33 项全过
- `/catalogue` 与 `/catalogue/44713` 均 HTTP 200；选择来源 API 写入并回读正确

---

## [0.1.17] - 2026-10-30

把编目数据库独立出来，并补上主库一直没吃进去的物理模型。

### 变更

- **独立编目库**（`docs/CATALOGUE.md`）：`npm run catalogue:build` 从 57 GB 工作库
  导出 `data/catalogue.sqlite`（**187 MB**，0.33%），13 张表逐表比对行数、
  `integrity_check` 通过。应用改由 `SPACE_SAFETY_DB` 只读这一个文件。
- **`npm run catalogue:report`**：按「在轨 / 全库」两个口径打印 17 个字段的覆盖率，
  并列出缺物理模型的对象。
- 主库新增 11 列：`hard_body_radius_m` `span_m` `diameter_m` `dry_mass_kg`
  `length_m` `ballistic_coefficient` `shape_number` `manufacturer` `bus`
  `orbit_type` `motor`。
- `/objects` 列表增加 COSPAR、目标分类、质量、国家四列。

### 修复

- **主库质量覆盖率 53% → 98%**：合并器只读 DISCOS（38 427 条），从未读
  `object_physics`（71 074 条，99.98%）与 `object_launch_info`（69 918 条）。
  32 648 个对象在源表里有质量、在主库里没有。现按 DISCOS 优先、物理表兜底合并。
- **硬体半径回填**：29 条新发射 Starlink 仍带旧的 8.83 m（翼展误作半径），
  已按 `hbr_mean_m` 重刷，残留清零。

### 验证

- `catalogue:build`：13 张表行数与源库完全一致，`integrity_check ok`
- `catalogue:report`：在轨 36 570 / 全库 72 311；质量、硬体半径、横截面积在轨 **96.65%**
- `tests/master-merge.test.ts` 33 项、`tests/catalogue.test.ts` 13 项全过
- `tsc --noEmit` 无错误

### 已知问题

- 1 226 个在轨对象无物理模型：1 143 个是 Analyst Sat（任何源都没有参数），
  73 个是 2026-10 新发射卫星（模型未入库），随 Spacebook 更新补齐
- 54 条未决冲突（53 条 DISCOS 衰降预测异常、1 条 SKYNET 4F 倾角差 2.5°）待人工判定

建立我们自己的主数据库：三源合并成一份事实，观测与计算严格分层。

### 变更

- **三层结构**（`docs/MASTER-DB.md`）：
  - **L1 `master_object`** — 72 311 个对象各一行，字段级优先级合并
  - **L1 `master_element_set`** — 指定每个对象用哪份星历（是"选择"，不是计算）
  - **L2 `derived_state`** — 446 694 行计算值，每行带 `method` 与 `inputHash`
  - **L3 `master_conflict`** — 54 条未决冲突，不自动消解
- **`npm run master:build`**：合并 + 派生，约 12 秒，可反复执行且结果可重现。
- **`tests/master-merge.test.ts`**：33 项，覆盖名称、类型、机动性、冲突检测、
  元素集选择与 schema 约束。

### 合并规则（均有实测依据）

| 字段 | 取自 | 依据 |
|---|---|---|
| 名称 | SATCAT | DISCOS 的 `OneWeb 0012` 是展示变体；66 436/71 175 名称不同但多为写法差异 |
| 类名 | **DISCOS** | 10 类 vs SATCAT 的 3 类；SATCAT 标 UNKNOWN 的 988 个 DISCOS 知其是 Payload |
| 质量/截面 | DISCOS | 其余源完全没有 |
| 机动性 | 计算一次后存储 | 只有 Payload 可机动；避免两个使用方得出不同结论 |

### 修复：OCM 被完全忽略

合并时按 `trajectories.state_source` 匹配注册表 id，但：

| 位置 | 实际值 |
|---|---|
| `trajectories.state_source` | `operator_ephemeris` |
| 注册表 id | `starlink-ocm` |

**一个 OCM 都没匹配上**，11 162 个 Starlink 全部退化成单点 TLE——
与"OCM 优先级最高"的设计完全相反。

改用 `file_format`（`ocm`/`itc`）映射后：

| source_id | 对象数 | 平均弧长 |
|---|---|---|
| `starlink-ocm` | **11 162** | **167.9 h** |
| `space-track` | 19 596 | 0 h |
| `spacebook-entity-tle` | 2 059 | 0 h |

### 修复：冲突阈值会产生噪声

初版把衰降日期差 >1 天就标记 → **306 条**。但 DISCOS 的 `predDecayDate` 是
**预测**，SATCAT 是**实际观测**，差 1–2 天是正常预测精度。

阈值改为 7 天后 → **53 条**，都是真问题（DISCOS 预测 2868 年、9999 年衰降，
实际这些对象早已衰降）。

> 会误报的告警清单等于没有清单。

### 验证

- `npx tsc --noEmit` 通过；`npm run check` 9 项全过。
- `tests/master-merge.test.ts` 33 项通过。
- `master:build` 连跑两次，L1 汇总（行数/总质量/总截面/可机动数）完全一致：
  `72311 | 56653711.482 | 767847.373 | 28241`

---


## [0.1.15] - 2026-10-29

预报一致性基线：量化 OCM 与 ITC 的差异究竟是什么，并纠正一处几乎写进结论的错误。

### 变更

- **`npm run forecast:baseline`**：把 OCM 与 ITC 对齐到同一绝对时刻，
  分解径向/沿迹分离，统计相位稳定性与协方差增长。
- **`src/lib/core/forecast-baseline.ts`**：坐标系在装载时统一旋转
  （OCM 是 ITRF2000，ITC 是 EME2000），越界一律返回 null，不外推。
- **`tests/forecast-baseline.test.ts`**：14 项，含"径向差必须小"、
  "相位必须主导"、"越界必须拒绝"三条回归护栏。

### 修正：一个几乎写进结论的错误

第一版把 OCM 与 ITC 直接相减，得出「6 小时预报误差 8 390 km」。**这是错的**，
两个 bug：

1. **越界采样**：从 ITC 起点取 OCM 的"最近点"时，该时刻不在 OCM 弧内，
   取到了弧外端点，单例算出 11 886 km。
2. **把相位差当预报误差**：两个产品的弧起点相差 3.5 小时，是两次独立拟合，
   相减主要得到相位偏置。

修正后 n=102 的实测：

| 时长 | 总分离中位 | **径向中位** | 相位中位 |
|---|---|---|---|
| 6 h | 8 390 km | **0.003 km** | 18.3 min |
| 12 h | 4 400 km | **0.002 km** | 9.6 min |
| 24 h | 4 240 km | **0.003 km** | 9.2 min |
| 48 h | 4 285 km | **0.000 km** | 9.4 min |

### 能证明的结论

- **两条轨迹是同一条轨道**：径向差中位 2–3 米，最大未超公里级。
- **分离量由相位偏置决定**，且相位中位在 12/24/48 h 几乎不变（9.2–9.6 min），
  **不随预报时长增长** → 可排除"预报在发散"。
- 协方差方向正确：σ 从弧首 0.0014 km 增至弧末 3.419 km。

### 新发现的反例

| 指标 | 值 |
|---|---|
| 相位偏移跨时长离散度中位 | 11.11 min |
| 离散度 <1 min 的对象 | **0 / 102** |

"两产品只是时钟不同步"这个假设**也不成立**：没有任何一个对象能用固定时间偏置
解释差异。已排除坐标系错误与固定偏置，**真正成因未知**。

### 仍然无法计算：预报精度

需要"Day 1 的预报 vs Day 5 的实况"，即同一对象的**跨日重复观测**。
当前每个对象只有 1 份 OCM，只有 1–3 天归档 → **数据不足，不做推断**。
这正是长期归档要实现的目标。

### 验证

- `npx tsc --noEmit` 通过；`npm run check` 9 项全过。
- `tests/forecast-baseline.test.ts` 14 项通过（20/20 对象径向差 <50 km，相位主导 20/20）。

---


## [0.1.14] - 2026-10-29

全量数据分析：25 个端点、507 MB 归档全部核验；分析工具与结论回归测试。

### 变更

- **`npm run analyze`**：五段式证据报告（覆盖度 / 新鲜度 / 物理模型 /
  跨格式一致性 / 传播一致性），每项带样本量，结果写 `data/analysis-report.json`。
- **`docs/ANALYSIS.md`**：结论与「数据不足」清单分开写。
- **`tests/analysis.test.ts`**：把报告里的每个数字变成断言；数据未下载时 skip 而非 fail。
- `source_fetches` 中 5 条永久 `running` 的僵尸记录标注为 `aborted`。

### 重要修正：此前的新鲜度结论是错的

之前写「Spacebook 滞后 17–77 小时」，依据是 `xp-tle`。实测 n=30 745：

| 端点 | 与 Space-Track 同历元占比 | 平均滞后 |
|---|---|---|
| `spacebook-entity-tle` | **99.98%**（30 740 / 30 745） | 0.2 h |
| `spacebook-omm` | **99.98%** | 0.2 h |
| `spacebook-xp-tle` | — | **66.2 h** |

只有 5 个对象历元不同。**把单个端点的滞后推广到整个供应商是错的**，
且这个错误影响了合并策略（把覆盖源当成了陈旧源）。

`registry.ts` 已改：`entity/tle` 与 `omm` 的 `typicalLagHours` 归 0，
`xp-tle` 标为 LEGACY 并降到最低轨迹优先级。

### 实测结论（全部来自数据库/归档，非推断）

| 结论 | 证据 |
|---|---|
| 单用 Space-Track 会漏 6.29% | Spacebook 独有 2 064 个对象 |
| XP-TLE 差异 92.8% 是纯相位 | n=2 993，径向 <10% 总差；径向中位 6.47 km |
| 三格式 OMM 完全等价 | JSON/KVN/XML 各 32 809 个唯一 NORAD，交集 = 并集 |
| 碎片几乎没有物理模型 | 15 680 个碎片仅 **6** 个有质量（0.04%） |
| 截面各向异性巨大 | 平均/最小 截面比中位 **19.84×** |
| 26.2% 在轨对象无质量 | 11 116 / 42 427 |

### 数据不足（明确列出，未做推断）

- DISCOS 质量/截面的**准确性**未验证（无第三方基准）。
- 32 个径向异常对象的**成因**无法区分（编号错配 / 机动 / 数据错误）。
- Spacebook 与 Space-Track 是否同源**无直接证据**（仅 99.98% 历元相同）。
- 长期改写历史数据**尚不可判断**（归档只有 1–3 天）。

### 验证

- `npx tsc --noEmit` 通过；`npm run check` 9 项全过。
- `tests/analysis.test.ts` 16 项全通过（独立复算，不读报告文件）。
- 25 个端点归档完整，`.part` 残留 0。

---


## [0.1.13] - 2026-10-29

DISCOSweb 全量下载完成，三源交叉验证可用；修正两处让对比结果失真的判定缺陷。

### 变更

- **DISCOS 物理参数入库**（`discos_objects` 表）。71 176 个对象，
  其中 38 427 有质量、37 624 有横截面积。这是另两源完全没有的数据。
- **`sources:load`**：从归档文件入库，不重新联网。
- **对比判定改用「沿迹相位误差」**（分钟）而非纯公里/漂移率。

### 实测：DISCOS 规模（此前严重高估）

| 资源 | 页数 | 记录数 |
|---|---|---|
| `objects` | 937 | 93 692 |
| `initial-orbits` | 642 | 64 186 |
| `destination-orbits` | 232 | 23 192 |
| `launches` | 74 | 7 379 |
| 其余 12 个 | 41 | <2 000 |

全量 1 926 页，8 并发约 **30 分钟**。早先估计的「93 692 页 / 21 小时」是
把 `total` 字段误当成 `totalPages`。

### 修复

- **参考源可能没有位置**：OCM 参与对比但无元素集历元，被选为参考后
  `jointMs` 为 NaN，全部位置为 null，把 1 492 个对象里的 **526 个**
  误报为 `unpropagatable`。改为只从「能产出位置且有历元」的源里选参考。
- **漂移率被短间隔放大**：OCM 弧起点与其拟合 TLE 的历元可能只差 1 小时，
  用 1 小时去除真实分离量，产生了 **315 987 km/天**（超过轨道速度）的数值，
  使 691/1930 被判为 suspect。现在 OCM 的历元记作 null，且要求间隔 ≥6 小时
  才计算日漂移率。
- 对比改为以相位误差为主判据后，`suspect` 从 691 降到 **24**，
  `agree`+`stale` 达 **97.3%**。

### 实测：相位误差证明「数据一致，只是相位老化」

NORAD 67685（GXIBA-1），两源历元差 71 小时，表面分离 12 466 km：

| 指标 | 值 |
|---|---|
| 径向差 | **89 km** |
| 沿迹差 | ~12 460 km（99.9%） |
| 相位误差 | **26.9 min**（463 km/min 轨道速度） |

结论：轨道本身一致，差异全部是沿迹相位；SGP4 不能外推 71 小时而已。

### 验证

- `npx tsc --noEmit` 通过；`npm run check` 9 项全过。
- `npm test` 28 个套件全通过（`sources` 新增 4 项回归断言）。
- 25 个端点、507 MB 归档完成，实测可离线重放。

---


## [0.1.12] - 2026-10-29

三源数据汇聚：Space-Track、Spacebook、ESA DISCOSweb 同时入库、互不覆盖，
可交叉验证；25 个端点全量下载并归档历史。

### 变更

- **多源存档层**（`data_sources` / `source_fetches` / `object_sources`）。
  在此以前两源的 TLE 都写成 `state_source='tle'`，后写入者直接覆盖前者，
  对比证据在写入时就丢了。现在每个源各存一行。
- **交叉验证器**（`src/lib/sources/compare.ts`）。把两源根数传播到同一时刻，
  按**每日漂移率**而非绝对公里数判定（固定阈值会让 57% 的目标误判为异常）。
- **25 个端点全量下载 + 历史归档**（`downloads.ts`、`archive.ts`）。
  补上了此前遗漏的 `spacebook satcat/details`（69 MB，含 DISCOS 与 McDowell 发射消息）。
- **DISCOSweb 客户端**：JSON:API 分页、扁平化、限流退避。
- **可断点续传的分页爬虫**（`paged-crawl.ts`）：每页落盘，重跑从缺失页继续。
- `GET /api/v1/object` 增加 `limit` / `offset`（默认行为不变，仍返回全部）。

### 实测结论（2026-10-29）

| 项目 | 结果 |
|---|---|
| XP-TLE vs OMM 历元差 | 17–77 h，Spacebook 系统性滞后 |
| Spacebook OMM vs Space-Track | 同一对象**历元与根数完全一致** |
| DISCOS `objects` 规模 | 93 692 页（×100 条） |
| DISCOS 并发上限 | 8 全通过；32 约半数 429 |
| 全量 25 端点 | 573 MB |

### 修复

- `satcat` 缺 `entity_id` 索引，supplemental 导入 7.2 万行时是 7.2 万次全表扫描，
  **3 分钟未完成**；加索引后 1 秒。
- DISCOS `links.next` 会重复当前页号，初版信赖它导致第 1 页被拉 120 次。
- DISCOS 429 退避原本只有 3 秒，6 次重试全部失败于第 104 页；改为 30 秒起指数退避。
- `extractAuthCode` 把 `https://…/#/xp-tle` 当成授权码返回。
- `dual-feed` 测试断言「每颗 Starlink 都有 OCM」，但 9 604 颗官方并不发布 OCM；
  改为断言「至少有一条轨迹」。

### 验证

- `npx tsc --noEmit` 通过；`npm run check` 9 项全过。
- `npm test` **28 个套件全通过**（新增 `sources` / `spacebook` / `spacebook-auth` / `discos` / `paged-crawl`）。

### 已知未完成

- DISCOS `objects` 全量约 21 小时，仍在后台抓取，断点续传中。
- Spacebook 需登录的 `/api/Scene`、`/api/Model`、`/api/UserEphemeris` 尚未接入，
  等待一次浏览器授权（Auth0 公共客户端只允许 `authorization_code`）。

---

## [0.1.11] - 2026-10-29

交互改为「悬停预览、点击锁定」。

> 补记：本条与下面两条在发布时漏写了日志，于 0.1.12 一并补齐。

### 变更

- 鼠标悬停卫星显示信息卡与轨道线预览，不改变选中状态。
- 点击锁定并保留轨道线，再次点击空白处取消。

---

## [0.1.10] - 2026-10-29

点选卫星查看详情。

### 变更

- 点击光点弹出信息卡，显示名称、NORAD、倾角与高度。

---

## [0.1.9] - 2026-10-29

接入 Cesium ion（可选），补上凭据泄漏检查。

### 变更

- `SPACE_SAFETY_CESIUM_ION_TOKEN` 经 `next.config.ts` 镜像为 `NEXT_PUBLIC_*`，
  未配置时仍使用自托管 `NaturalEarthII` 瓦片，不发起外部请求。
- `no-secrets` 检查增加 JWT 内容扫描：用户曾把 ion token 直接贴进对话。

---


## [0.1.8] - 2026-10-29

地球表面改用 Cesium 自带的分级瓦片底图，删除手塞的 2.5 MB 全幅贴图。

### 变更

- **底图换成 `NaturalEarthII` TMS 瓦片**。上一版用 `SingleTileImageryProvider`
  把一张 5400×2700 的 Blue Marble（2.5 MB）当作单瓦片加载——无论视角如何都是全量下载，
  无法分级，而且这幅写实地表在轨道数据视图里喧宾夺主。
  现在用的是 Cesium 包自带的 `Assets/Textures/NaturalEarthII`（三个层级共 42 张、608 KB），
  随 `public/cesium/` 一起部署，**没有新增文件**。
- 删除 `public/geo/earth-blue-marble.jpg`（2.5 MB），`public/geo/` 目录随之移除。
- URL 使用 `{z}/{reverseY}/{x}`：这套瓦片是 TMS 行序（原点在南极），
  用 XYZ 会得到上下颠倒但依然“看起来合理”的地球，很容易蒙混过关；
  代码里写了为什么。

### 验证

- `npx tsc --noEmit` 通过；`npm run check` 9 项全过。
- `/cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg` 200（12 KB）、
  `/…/2/0/1.jpg` 200（9 KB）；`/geo/earth-blue-marble.jpg` 返回 404。

### 已知问题

- `NaturalEarthII` 最高只有 z=2（约 0.176°/像素），拉得很近时地表会发糊。
  轨道数据视图里可接受；若将来需要近地视图，再加一层更高分辨率底图。

---

## [0.1.7] - 2026-10-29

按反馈移除地球上 177 个国家名称标注；国名数据作为参考数据归档保留。

### 变更

- **国名标注从视图移除**（`CesiumGlobe.addCountryLabels` 删除）。
  在以北半球 13 000 颗卫星为主体的视图里，177 个国名是屏幕上最密的文字，
  却和轨道无关；读者需要的方位感，经纬网已经提供。`addBasemap()` 现在只画经纬网。
- **国名数据归档到 `data/reference/countries-110m.geojson`**，从 `public/geo/` 移出。
  原先它作为静态资源对外公开（`/geo/countries-110m.geojson` 可直接下载），
  而实际用途只是备用，不应被浏览器拉取。`npm run fetch:geo` 的输出路径同步修改。
- **`src/lib/geo/countries.ts` 保留并扩展**：它是归档数据的解析器，不是渲染器。
  现在保留全部 27 种语言名（原先只读 6 种就丢弃其余），因为这份数据存在的意义就是备用。
  文件头注释说明了「为什么不渲染」与「为什么还留着」。
- 新增 `data/reference/README.md` 记录归档的来源、生成命令与用途。
  `.gitignore` 只放行该说明文档，数据文件本身仍不入库。
- `ConstellationGlobe` 不再接收 `locale`，也不再请求国界 GeoJSON。

### 验证

- `npx tsc --noEmit` 通过；`npm run check` 9 项全过。
- 解析器实测：177 国，中国可读到 27 种语言名，标注锚点在 103.87°E / 36.61°N。
- `/geo/countries-110m.geojson` 返回 404（预期：已不再对外提供），首页 200。

---

## [0.1.6] - 2026-10-29

把首页的地球视图统一到 Cesium，并修掉一次全量星座渲染卡死浏览器的问题。

### 修复

- **13 000 条轨道不再绘制**（`src/components/cesium/CesiumGlobe.ts`）。
  上一版为每颗卫星画一整圈轨道折线，13 000 条 × 约 100 段，光晕全部堆在地球边缘，
  帧率跌到不可用。现在**每颗卫星只画一个光点**（`PointPrimitiveCollection`，
  一个图元批量提交），并按 `ORBIT_PERIOD_SECONDS` 沿采样轨道推进位置，
  整片星座每帧只写 13 000 个 `position`、不分配任何对象。
- **切换主题时光点不变色**。现在 `applyTheme` 同步按壳层重算光点颜色。
- **每帧重建 13 000 个材质**。`tick()` 原本每帧给所有轨道重新赋材质，
  开销超过整个场景其余部分，视觉上还表现为闪烁而不是运动。
- **经纬网建了又删**。`addGrid()` 先加一个实体再立刻移除，留下游离实体。
- **切换语言时国名叠加**。`addBasemap` 重新调用只追加不清理，现在先移除旧标签。
- `CesiumGlobe` 的 `addBasemap` / `addConstellation` 缺参数（`locale`、壳层配色），
  与 `ConstellationGlobe` 的调用不匹配。

### 变更

- 首页的轨道视图从 Three.js（`HomeViewer` + `OrbitViewer`）换成 Cesium
  （`ConstellationGlobe`），显示全量星座而非最新 60 条。
  TLE 只用于显示这条边界没有变：交会筛查仍只读 OCM。
- 经纬网改用一个 `PolylineCollection` 图元；国家名称仍走实体路径
  （标签自动避让只有实体系统提供，177 个在其设计密度内）。
- `public/cesium/`（Cesium 运行时资源，7 MB）与 `public/data/`（星座快照，12 MB）
  不再入库。新增 `tools/copy-cesium.ts` 并在 `postinstall` 里自动执行，
  只拷 `Workers`/`Assets`/`ThirdParty`/`Widgets` 四个运行时目录，
  不拷 `Cesium.js`/`index.js`/`index.cjs` 那 15 MB 模块入口。
- 删除被取代的实现：`src/components/globe/*`、`OrbitViewer.tsx`、`HomeViewer.tsx`、
  `src/lib/vi/scene.ts`、`/api/render/tracks`，以及只服务于它们的 `viewer.*` 字典键
  （六语种同步删除）与 `.viewer*` 样式。
- `tools/check.ts` 的 VI 场景检查改为扫描 `src/components/cesium/`，
  原先只检查已删除的 `OrbitViewer.tsx`，等于空转。
- `next.config.ts` 增加 `allowedDevOrigins`，消除本机通过 LAN 地址访问时的警告。

### 验证

- `npx tsc --noEmit` 通过；`npm run check` 9 项全过（i18n 6×283 键）。
- `npm run serve` 后首页 200，`/data/constellation.json` 200（12.7 MB）、
  `/geo/countries-110m.geojson` 200、`/cesium/Widgets/widgets.css` 200。

### 已知问题

- 光点用恒定像素大小，拉近时不会随之变大；后续可改成按距离缩放。
- 无头 Chrome 下 WebGL 不可用，本机未能截图核验渲染结果，需在真实浏览器确认。

---

## [0.1.5] - 2026-10-29

统一命名：项目所有层面只使用 **spacesafety**，不再出现旧名 `spaceeyes`。

### 变更

- 包名、GitHub 仓库、本地项目目录、数据库文件全部改为 `spacesafety`
  （`data/spaceeyes.sqlite` → `data/spacesafety.sqlite`，原有 53 GB 数据原地重命名，未重新导入）。
- 环境变量前缀 `SPACE_EYES_` → `SPACE_SAFETY_`，共 37 个，代码读取点 111 处。
- gRPC 包名 `spaceeyes.worker.v1` → `spacesafety.worker.v1`（**线协议不兼容**，
  入口层与计算端必须同时升级）。
- 演示认证头 `x-space-eyes-operator` → `x-space-safety-operator`。
- 日志前缀 `[space-eyes]` → `[space-safety]`，CDM 生成方标识 `SPACEEYES` → `SPACESAFETY`。
- 页面标题、侧栏品牌、下载脚本 User-Agent 统一为 Space Safety。
- 新增 `.env.example`：列出全部 37 个变量并逐个标注用途，已用脚本校验
  每一项都在代码中存在读取点。

### 修复

- 下载工具读的是裸 `PROXY` 且默认硬编码 `http://127.0.0.1:20171`，
  导致 `.env.local` 里的 `SPACE_SAFETY_PROXY` 被静默忽略，且无代理的机器上仍会先试代理。
  改为读文档化的变量名，默认直连。
- 改名后标题出现 `Space Safety — Space Safety`，已合并为单一标题。

### 验证

- `npm test`：23 个套件全过。
- `tsc --noEmit` 无错误。
- 数据库重命名后校验：`catalog` 与 `objects` 均为 11 162 行，数据完整。
- 服务以新名启动：`/`、`/conjunctions`、`/objects` 均返回 200。

---

## [0.1.1] - 2026-10-29

首个纳入版本库的版本。此前的工作区从未初始化 git，因此这一版是全部既有功能的
基线快照，同时包含下面这批直接影响「能不能把全量星座算完」的修复。

### 修复

- **全量筛查被系统 OOM 杀死 / 机器进入交换**。三个独立原因，都已定位并修复：
  - 每个 worker 在 `covAt` 里把 36 个协方差元素拷成普通数组（V8 堆对象），
    而轨迹本体是共享内存。24 个线程各自持有全量协方差的私有副本，
    2 400 个对象时进程 RSS 达 **103 GB**。改为只读 3×3 位置块到可复用暂存数组，
    协方差全程留在共享缓冲里。
  - 打包轨迹被额外写入内核的 4 096 条内容缓存，导致「已驱逐」的轨迹仍被引用。
    移除该冗余注册（`cacheTrack` 保留给单次作业路径）。
  - worker 解析后保留的 `parsed` / `sources` / `stateCache` 在装载打包轨迹时未清理，
    同一轨迹的线格式对象（每文件约 10 000 个对象）常驻堆。装载打包轨迹时一并回收。
- **每个 worker 首批任务卡死约 240 秒**：V8 首次调用 `screenTracks` 时整函数编译，
  2 400 个对象时 24 个线程同时卡住、日志长时间显示 0 对。改为小分片派发
  （`--chunk`，默认 20 个外层对象一片），编译预算摊开后推进变平滑。
- **窗口剪枝实际剪枝率为 0**（文档中的 80% 是旧数据的结论）。窗口包围盒按
  「采样间距 × 7.6 km/s」膨胀，60 s 采样即每边 1 106 km，而同一壳层卫星相距仅数十公里，
  所有盒子全部重叠。改为按**真实采样点**构建包围盒（只按筛查盒半对角线膨胀），
  并新增包围盒前置过滤，实测 300 个真实对象上剪掉 77% 的配对。
- **筛查误用了上传规则的「未来窗口」校验**：轨迹结束超过 24 小时即整份拒绝。
  星链 OCM 是固定 7 天弧段，下载 8 天后整个星表全部解析失败，全量筛查实际跑的是 0 对。
  新增 `normaliseTrajectory(raw, { enforceFutureWindow })`，上传路径保持原规则，
  后台重算与筛查关闭该规则。
- **驱动层 `--max-old-space-size` 不生效**：`NODE_OPTIONS` 在运行时设置无效（V8 只在
  isolate 创建时读取一次）。改为用真实 argv 重新 exec 自身；同时不再把堆参数转发给
  worker（`ERR_WORKER_INVALID_EXEC_ARGV`）。
- 驱动读取星历改为 `Buffer`（堆外），不再经 ORM 生成字符串；批次记录只保留
  轨迹 id 的哈希，不再持有整批原文。

### 变更

- `scripts/screen-parallel.ts`：新增 `--chunk`、`--window`；心跳日志按分钟输出进度；
  同一对象在 catalog 中重复出现时只筛查一次。
- 新增 `tools/serve.py`：以独立会话启动/重启 Web UI，关闭终端不影响服务。
- 新增 `tools/probe-screen.py`：可重复运行的性能探针（摄入耗时、每对耗时分布、
  完整星表的推算时长），用于以后改动内核前后的对照。

### 验证

- `npm test`：23 个测试套件、43 条断言全部通过。
- 与改动前的参考输出**逐条比对**（600 个对象、179 700 对）：261 对接近 / 1 124 个交会，
  miss、相对速度、Pc 数值完全相同。
- 2 400 个对象（2 874 003 对）完整跑通，0 对因轨迹未驻留而跳过。

### 已知问题

- 全量星座（11 162 对象 / 6 225 万对）在 24 线程下的内存峰值尚未重新实测，
  启动前应先跑一次 `--limit 2400` 观察 RSS。
- `tests/` 下的部分用例依赖 `data/` 中的真实星历，仓库内不含数据，
  在干净克隆上需先执行下载脚本。

---

## [0.1.0]

初始实现：遵循 `docs/SPEC-BEHAVIOR.md` 的仿制服务，包含
mTLS、REST 接口、SQLite 存储、OCM/TLE/OMM 摄入、SGP4/HPOP 传播、
交会筛查内核（Alfano 2D Pc）、gRPC 计算端与 Next.js + Three.js 界面。
