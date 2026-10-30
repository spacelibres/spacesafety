# 卫星编目库定稿

**版本：v0.1.63　数据基准：2026-10-30 抓取　状态：定稿**

本文件是卫星编目数据库的**唯一权威说明**。后续任何改动必须先改本文件。

其他 `docs/CATALOGUE-*.md`、`docs/KEEPTRACK-*.md`、`docs/WIDE-CATALOGUE.md`
是各自测量时刻的分析记录，**不是定稿**；与本文件冲突时以本文件为准。

---

## 一、定稿结论

编目库当前状态**已接受、不再调整**。

| 项 | 定稿值 |
|---|---|
| 宽表行数 | **72,402** |
| 宽表列数 | **157** |
| 来源数 | **5** |
| 分类表行数 | **72,402**（与宽表零缺口）|
| 三维模型 | **299**（NASA 257 + Spacebook 42）|

**两个已知缺口不做补齐**，理由见第六节。

---

## 二、五个数据源

| 源 id | 机构 | 对象数 | 定位 |
|---|---|---|---|
| `spacetrack` | 美国太空军第 18 太空防御中队 | 71,198 | 美国官方基准编目 |
| `spacebook` | AGI/STK + ComSpoc | 71,088 | 商业推导物理模型 |
| `discos` | 欧空局 ESA | 71,176 | 科研实测数据 |
| `keeptrack` | keeptrack.space | 34,006 | 主要贡献直径字段（`keeptrack_object` 原表 35,203 行，能对上 NORAD 的 34,006 个）|
| `sbsup` | Spacebook 分析型目标 | 1,112 | 无编目号的临时编号目标 |

**来源集合差异（已查清，非缺陷）：**

| 来源 | 独有对象 | 性质 |
|---|---|---|
| Space-Track | 6 | 2026 年新发射，其他源尚未同步 |
| Spacebook | 0 | — |
| DISCOS | 1 | NORAD 69475，CZ-5 上面级 |
| KeepTrack | 0 | 682 个「独有」实为分析型目标 |

---

## 三、数据库文件

| 文件 | 大小 | 内容 | 是否入库 |
|---|---|---|---|
| `data/catalogue.sqlite` | 238 MB | 各源原样表 + 分类表 + 事件表 | 否（`data/*` 已忽略）|
| `data/catalogue-wide.sqlite` | 48 MB | 宽表 72,401 × 157 | 否 |
| `data/archive/` | 约 480 MB | 各源原始抓取文件（JSON/CSV）| 否 |
| `data/models/` | 781 MB | NASA 257 个 `.glb` + 257 张预览图 | 否 |

**仓库只存代码，不存数据。** `*.sqlite` 已全局忽略。

---

## 四、宽表结构

一个对象一行，每个字段并排保存各来源原值，另有一列记录采用哪个。

```sql
catalogue_wide (
  norad_id INTEGER PRIMARY KEY,

  mass_kg__spacetrack REAL,  mass_kg__spacebook REAL,  mass_kg__discos REAL,
  mass_kg__keeptrack REAL,   mass_kg__sbsup REAL,
  mass_kg__chosen     TEXT,   -- 来源名，或 NULL

  ...
)
```

**`__chosen` 存的是来源名，不是值。** 取值：`spacetrack` / `spacebook` / `discos` /
`keeptrack` / `sbsup` / `NULL`。

字段清单（26 个）：

```
name                cospar_id           object_class        country
launch_site         launch_date         decay_date          inclination_deg
period_min          apogee_km           perigee_km          rcs_size
mass_kg             hard_body_radius_m  cross_section_avg_m2 cross_section_max_m2
cross_section_min_m2 span_m             diameter_m          ballistic_coefficient
shape               manufacturer        bus                 orbit_type
dry_mass_kg         length_m
```

26 × 5 + 26 + 1 = **157 列**。

---

## 五、分类表

`object_classification`，72,401 行，与宽表一一对应。

| 维度 | 取值 |
|---|---|
| `country` | 发射国/地区代码 |
| `constellation` | Starlink 12,972、Cosmos 13,358、Iridium 859、Planet 692 等 |
| `operator` | 运营方 |
| `purpose` / `purpose_group` | 通信 8,629、对地观测 672、技术试验 444 等 |
| `regime` | LEO / MEO / GEO / HEO / UNKNOWN |
| `regime_basis` | `computed`（由远近日点算）/ `stated`（来源声明）/ `unknown` |
| `bus` | 平台型号 |

**轨道类型分布：**

| 类型 | 数量 |
|---|---|
| LEO | 64,887 |
| HEO | 3,459 |
| GEO | 1,793 |
| MEO | 1,740 |
| UNKNOWN | 523 |

---

## 六、两个已知缺口（定稿：不补齐）

### 6.1 轨道类型 UNKNOWN 523 个

缺 apogee/perigee，且无任何来源声明轨道类型。

**不补齐的理由：** 只能靠名称猜测，猜错会直接污染分类统计，且猜测值与实测值无法区分。

### 6.2 硬体半径在轨缺失 1,539 个

总缺口 33,737（46.6%），但其中 **32,198 是已再入对象**，不影响在轨计算。

在轨 1,539 个的构成：

| 类别 | 数量 | 能否补齐 |
|---|---|---|
| 分析型目标 | 1,111 | **不能**——身份未知，不会有物理模型 |
| Space-Track 有记录 | 337 | 上游无模型 |
| 仅 KeepTrack/DISCOS 有 | 91 | 无模型来源 |

337 个候选者中可用其他字段推算的：**2 个**（KeepTrack 直径或横截面积），见
`tools/hbr-gap-candidates.ts`。

**为什么 Spacebook 有记录也没半径**（抽查 NORAD 51/52/53/115/119）：

```
name__spacebook               = "ECHO 1 DEB (MYLAR OBJ)"
hard_body_radius_m__spacebook = NULL
mass_kg__spacebook            = NULL
```

质量与半径**同时为空**，是上游未建模，不是解析丢失。

**不补齐的理由：** 现有四个数据源里没有这些数据。要补只能引入新的模型数据源。

---

## 七、重建流程

### 7.0 每日刷新（首选：一条命令）

```bash
npm run data:daily            # 按各源节奏抓取 + 入库 + 宽表 + 分类 + 事件
npm run data:daily -- --force # 忽略节奏，全部重抓
```

顺序是**下载 → KeepTrack → 入库 → 宽表 → 分类 → 事件**，每一步都验证过；
脚本会打印刷新前后逐表行数，行数变少会显式告警，宽表与分类表不一致直接失败。

**不要把 `npm run catalogue:build` 放进这条流程。** 它用工作库（`data/spacesafety.sqlite`）
重建 `data/catalogue.sqlite`，而 `keeptrack_object` 等表**只存在于后者**，重建后即丢失
（2026-10-30 实测踩到：35,203 行被清空，需重跑 `keeptrack:sync` 才能恢复）。
`catalogue:build` 的用途是"生成对外发布的小库"，不是日常刷新的一步。

### 7.1 从归档重建（不重新下载）

编目库可完全从归档重建，顺序不可颠倒：

```bash
# 1. 各源原样表（从 data/archive 读入）
npm run sources:load

# 2. 宽表（五源并列，157 列）
npx tsx tools/build-wide-catalogue.ts

# 3. 分类表（必须在上一步之后）
npm run catalogue:classify

# 4. 三维模型
npx tsx tools/models-sync.ts            # NASA 257
npx tsx tools/models-restore-spacebook.ts  # Spacebook 42（需已有 spacebook_model）

# 5. 验证
npm run test:wide
npm run check
```

**第 2 步与第 3 步的顺序不能颠倒**：分类脚本的 universe 依赖宽表的对象集合。
**`catalogue:classify` 会先 `DELETE FROM object_classification` 再全量写入**，
中途失败会导致分类表为空。

---

## 八、核查脚本（只读）

```bash
npx tsx tools/catalogue-source-overlap.ts    # 各源覆盖数、重叠分布
npx tsx tools/keeptrack-only-explained.ts    # KeepTrack 独有对象是否都是分析型目标
npx tsx tools/keeptrack-only-wide.ts         # 从宽表视角看单源对象
npx tsx tools/hbr-gap-audit.ts               # 硬体半径总覆盖
npx tsx tools/hbr-gap-detail.ts              # 半径缺口按分类/来源分布
npx tsx tools/hbr-gap-candidates.ts          # 337 个候选者能否推算
```

---

## 九、踩过的坑（必须记住）

### 9.1 统计口径：必须查该源全部列

判断「某来源有没有这个对象」，**必须检查该来源在宽表的全部 26 列**。

第一次只用 `name` / `cospar_id` / `inclination_deg` 三四列，报出 90 个「四源全空」。
实际 Spacebook 持有它们的名字，只是名字在没被检查的列里。

### 9.2 构建失败必须看完整日志

重建宽表时 `SOURCES` 里的 `sb-supplemental` 未替换成 `sbsup`，列名带连字符导致
SQL 语法错误。因为只看了 `grep` 过滤后的输出，**宽表被 DROP 后没建出来，一度为空**。

**改 SQL 或列名后，必须先 `SELECT COUNT(*)` 确认行数，再用 grep 过滤。**

### 9.3 CSS 变量名

`--color-accent` 是 VI token 定义的真名，**不是** `--accent`。CSS 对未定义变量不报错，
只会让整条声明失效。批量替换已造成三次事故。

### 9.4 相对路径的 ATTACH

SQLite 的 `ATTACH DATABASE '相对路径'` 相对于**主数据库文件所在目录**解析，不是当前工作目录。
核查脚本曾在仓库根目录建出一个 0 字节的 `catalogue-wide.sqlite`。

**脚本里一律用 `resolve()` 转绝对路径。**

### 9.5 分析型目标的号段不唯一

分析型目标分布在三个号段（80xxx / 270xxx / 290xxx），共 1,112 个。
曾只筛 `norad_id >= 270000`，得到 429 个，漏掉的 683 个让 KeepTrack 看起来独有一批未知目标。

**筛选条件是 `name LIKE '%Analyst Sat%'`，不是号段。**

### 9.6 两张模型表

`spacebook_model`（Spacebook 目录，42 条）与 `model_asset`（UI 读取，NASA 257 条）
是两张表，长期没有桥接，模型库报表 299 实际只有 257。
现在由 `tools/models-restore-spacebook.ts` 补齐，但 Spacebook 的 `.glb` 文件本身不在本地。

---

## 十、定稿后允许的改动

以下改动**不改变编目数据**，允许进行：

- 新增核查脚本
- 修复页面渲染或查询错误
- 补充 i18n 文案
- 新增数据源（需先改本文件，并重新评估第二、六节）

以下改动**必须重新评审**：

- 修改宽表的 `SOURCES` 或字段清单（会改变 157 列结构）
- 修改分类规则
- 引入外部数据源补齐第六节的缺口
- 改变 `__chosen` 的默认来源偏好
