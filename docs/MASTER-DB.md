# 主数据库结构

> 目标：把三个来源的数据整合成**我们自己的数据库**，并严格区分
> 「观测到的」与「我们算出来的」。
> 构建命令：`npm run master:build`（约 12 秒，可反复执行）

---

## 为什么要分层

如果不分层，会出现这些问题：

- 一个我们算出来的高度被引用成"Space-Track 的数据"
- 上游数据更新后，缓存的计算结果没有失效，但没人知道它已经过期
- 两个源冲突时，代码随手取一个值，事后无法证明曾有过冲突

所以数据库分三层，**每层的表名就说明了它的可信性质**。

---

## 三层结构

```
┌─────────────────────────────────────────────────────────────┐
│  L0  源表（证据层）——每个供应商一张表，原样保存              │
│  satcat / discos_objects / object_sources / trajectories     │
│  spacebook-entity-tle / space-track / spacebook-omm ...       │
└──────────────────────────┬──────────────────────────────────┘
                           │  npm run master:build（合并）
┌──────────────────────────▼──────────────────────────────────┐
│  L1  主表（我们认定的事实）                                   │
│  master_object        每对象一行，字段级优先级合并            │
│  master_element_set   指定用哪一份星历（选择，不是计算）      │
└──────────────────────────┬──────────────────────────────────┘
                           │  同一命令的第二阶段（计算）
┌──────────────────────────▼──────────────────────────────────┐
│  L2  派生层（我们算出来的）                                   │
│  derived_state        每行带 method + inputHash，可随时重算   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  L3  未决冲突（我们没敢决定）                                  │
│  master_conflict      记录分歧，不自动消解                    │
└─────────────────────────────────────────────────────────────┘
```

---

## L1：主表

### `master_object`（72,311 行）

一个物理对象一行。**字段级优先级**如下，每条都有实测依据：

| 字段 | 取自 | 依据 |
|---|---|---|
| `name` | SATCAT / entity-tle | 运营方使用的短名。DISCOS 的 `OneWeb 0012`、`Calsphere 4` 是展示变体，不是另一个身份——71,175 个对象里 66,436 个名称不同，绝大多数只是写法差异 |
| `alias_names` | DISCOS | 差异名称保存在这里，使 `OneWeb-0010 (ChusigSat)` 可被检索到，但不覆盖主名 |
| `object_class` | **DISCOS** | DISCOS 分 10 类，SATCAT 只有 3 类。实测：SATCAT 标 `UNKNOWN` 的 988 个对象 DISCOS 知其是 Payload；SATCAT 标 `DEBRIS` 的 606 个是 Payload |
| `satcat_type` | SATCAT | 粗分类保留，因为筛查策略读它 |
| `mass_kg` | DISCOS | 其余源完全没有 |
| `cross_section_*` | DISCOS | 同上 |
| `maneuverable` | **计算一次后存储** | 规则：只有 `Payload` 可机动。存结果而不是每次重算，避免两个使用方得出不同结论 |
| `decay_date` | SATCAT | 实际衰降日期；DISCOS 的 `predDecayDate` 是预测 |
| `status` | SATCAT supplemental | `Active` / `Dead` / `Debris` / `RocketBody` |
| `covariance_start/stop` | SATCAT supplemental | 决定能否算 Pc |
| `sources` / `source_count` | 合并时统计 | 哪些源提供了这个对象 |

### `master_element_set`（32,823 行）

指定每个对象**使用哪一份星历**。这是**选择**，不是计算——原始数据仍留在 L0。

优先级（低值优先）：

| 优先级 | source_id | 弧长 | 对象数 |
|---|---|---|---|
| 10 | `starlink-ocm` | 168 h，带协方差 | **11,162** |
| 11 | `starlink-itc` | 72 h，带协方差 | 0（都有更好的 OCM） |
| 20 | `space-track` | 单点 TLE | 19,596 |
| 23 | `spacebook-entity-tle` | 单点 TLE | 2,059 |

> **修复记录**：OCM 存在 `trajectories.state_source = 'operator_ephemeris'`，
> 而注册表里叫 `starlink-ocm`。合并时按 `state_source` 匹配 → **一个 OCM 都没找到**，
> 11,162 个 Starlink 全部退化成单点 TLE，与设计意图完全相反。
> 现按 `file_format` 映射，已修复并加回归测试。

---

## L2：派生层

每行都带 **`method`**（怎么算的）和 **`input_hash`**（输入指纹）。
输入变了，行就过期了——读者能看出来，而不是以为它是事实。

| kind | 字段 | 方法 | 说明 |
|---|---|---|---|
| `orbit-summary` | `altitude_km` | `kepler-from-mean-motion` | 从平均运动反推，**不取 SATCAT 的周期**（不同历元） |
| | `semi_major_axis_km` | 同上 | |
| | `period_min` | 同上 | |
| | `inclination_deg` / `eccentricity` | `element-set@epoch` | 取**被选中的**那份星历 |
| `coverage` | `epoch_age_hours` | `now-minus-epoch` | 依赖当前时间，每次重建 |
| | `arc_hours` | `end-minus-start` | |
| `source-agreement` | `sources_holding` | `count-distinct-source` | 有几个源认识它 |
| | `has_mass` / `has_cross_section` | `*-not-null` | |

**规则：L2 的任何值都不回写到 L1。** 算错了，删掉重跑即可，上游不受影响。

---

## L3：未决冲突

**54 条**，全部保留待人工核查，不自动消解。

| 字段 | 数量 | 性质 |
|---|---|---|
| `decay-date` | 53 | DISCOS 的衰降预测荒谬（如预测 2868 年、9999 年），而这些对象早已衰降 |
| `inclination` | 1 | SKYNET 4F：SATCAT 9.74° vs 轨道源 12.265°，差 2.5° |

> **阈值经过实测校准**：初版把衰降差 >1 天就标记，得到 306 条——
> 但 DISCOS 的 `predDecayDate` 是**预测**，SATCAT 是**实际观测**，两者差 1–2 天
> 是正常的预测精度，不是矛盾。阈值改为 7 天后降到 53 条，
> **都是真正需要看的**。会误报的告警清单，等于没有清单。

---

## 使用规则（必须遵守）

```ts
// ✅ 需要事实：读 L1
const obj = db.prepare("SELECT * FROM master_object WHERE norad_id = ?").get(norad);

// ✅ 需要知道该用哪份星历：读 L1 的选择表
const chosen = db.prepare("SELECT * FROM master_element_set WHERE norad_id = ?").get(norad);

// ✅ 需要派生数值：读 L2，并且**必须同时读 method**
const alt = db.prepare(
  "SELECT value_num, unit, method FROM derived_state WHERE norad_id = ? AND field = 'altitude_km'"
).get(norad);

// ❌ 禁止：把 L2 的值当作观测值引用
// ❌ 禁止：在两个源冲突时随手取一个（应检查 master_conflict）
```

---

## 当前主库规模

| 层 | 表 | 行数 |
|---|---|---|
| L1 | `master_object` | **72,311** |
| | 其中有质量 | 38,427 |
| | 其中有横截面积 | 37,624 |
| | 其中 Payload | 28,229 |
| L1 | `master_element_set` | **32,823** |
| L2 | `derived_state` | **446,694** |
| L3 | `master_conflict` | **54** |

---

## 复现

```bash
npm run master:build              # 合并 + 派生，约 12 秒
npm run master:build -- --skip-orbits   # 只做合并
npm run master:build -- --report        # 只看现状
npm run test:master               # 33 项合并规则测试
```

**L0 的数据没变时，重复执行结果完全一致**（除 `epoch_age_hours`，它本来就依赖当前时间）。
