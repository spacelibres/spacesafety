# 编目宽表（三源并列）

## 这是什么

一张表，**一个对象一行，每个字段并排保存三个来源的原值**，另有一列记录用户选择采用哪个。

我们**不替用户裁决**。三家各有官方身份：

| 源 | 机构 | 定位 |
|---|---|---|
| `spacetrack` | 美国太空军第 18 太空防御中队 | 美国官方基准编目 |
| `spacebook` | AGI/STK + ComSpoc | 商业推导物理模型 |
| `discos` | 欧空局 ESA | 科研实测数据 |

同一字段三个值不同，不代表有错误——代表三个权威机构各说各话。**三个值必须都留着。**

## 表结构

```sql
catalogue_wide (
  norad_id INTEGER PRIMARY KEY,

  mass_kg__spacetrack REAL,  mass_kg__spacebook REAL,  mass_kg__discos REAL,
  mass_kg__chosen     TEXT,   -- 'spacetrack' | 'spacebook' | 'discos' | NULL

  hard_body_radius_m__spacetrack REAL, ...__spacebook REAL, ...__discos REAL,
  hard_body_radius_m__chosen TEXT,
  ...
)
```

- **26 个字段 × 4 列 + norad_id = 105 列**
- `__chosen` 为 NULL 表示该字段无任何来源有值
- `__chosen` 可逐对象修改，三个原值永不覆盖

## 规模

| 项 | 值 |
|---|---|
| 对象 | 71,201 |
| 列 | 105 |
| 文件 | `data/catalogue-wide.sqlite`，42.3 MB |
| 构建 | `npx tsx tools/build-wide-catalogue.ts` |

---

## 当前默认选择（Space-Track 优先）

**原则：Space-Track 是官方基准编目，凡它有值的字段，默认采用 Space-Track。**

| 字段 | 默认 | Space-Track | Spacebook | DISCOS | 说明 |
|---|---|---|---|---|---|
| name | **spacetrack** | 71,198 | 71,088 | 70,467 | |
| cospar_id | **spacetrack** | 71,198 | 71,088 | 71,175 | |
| object_class | **spacetrack** | 71,198 | 0 | 71,177 | DISCOS 细分 12 类，保留在其列 |
| country | **spacetrack** | 71,198 | 0 | 0 | |
| launch_site | **spacetrack** | 71,198 | 0 | 0 | |
| launch_date | **spacetrack** | 71,198 | 0 | 0 | |
| decay_date | **spacetrack** | 35,740 | 36,497 | 34,729 | 实测；DISCOS 为预测；**Spacebook 的 GCAT DecayDate 不可当再入用**，见下 |
| inclination_deg | **spacetrack** | 69,073 | 69,852 | 0 | 当前轨道 |
| period_min | **spacetrack** | 69,086 | 0 | 0 | |
| apogee_km | **spacetrack** | 69,086 | 0 | 0 | |
| perigee_km | **spacetrack** | 69,086 | 0 | 0 | |
| rcs_size | **spacetrack** | 58,233 | 0 | 0 | |
| shape | discos | 0 | 0 | 37,739 | **唯一来源** |
| mass_kg | discos | **0** | 71,074 | 38,427 | 见下方说明 |
| hard_body_radius_m | spacebook | 0 | 71,074 | 0 | **唯一来源** |
| cross_section_avg_m2 | spacebook | 0 | 71,074 | 37,624 | |
| cross_section_max_m2 | discos | 0 | 0 | 37,684 | **唯一来源** |
| cross_section_min_m2 | discos | 0 | 0 | 37,676 | **唯一来源** |
| span_m | spacebook | 0 | 71,072 | 36,994 | |
| diameter_m | spacebook | 0 | 12,654 | 12,655 | |
| ballistic_coefficient | spacebook | 0 | 71,074 | 0 | **唯一来源** |
| manufacturer | spacebook | 0 | 46,251 | 0 | **唯一来源** |
| bus | spacebook | 0 | 38,261 | 0 | **唯一来源** |
| orbit_type | spacebook | 0 | 69,893 | 0 | **唯一来源** |
| dry_mass_kg | spacebook | 0 | 37,867 | 0 | **唯一来源** |
| length_m | spacebook | 0 | 37,698 | 0 | **唯一来源** |

### 唯一的例外：mass_kg

**Space-Track 不提供质量**（71,198 条记录中 0 条有质量）。这不是我们没抓到，是该源根本不发布。

所以质量只能在 DISCOS 与 Spacebook 之间选：

| 方案 | 结果 | 取舍 |
|---|---|---|
| **当前：DISCOS 优先** | 38,427 个用实测值，其余 32,647 个由 Spacebook 补 | 有一半是仪器实测 |
| 备选：Spacebook 优先 | 全部 71,074 个统一用同一模型 | 数值一致性好，但全是推导值 |

两源在 38,426 个共有对象上**只有 27 条差异（0.07%）**，所以这个选择对绝大多数对象没有影响。

如需切换，改 `tools/build-wide-catalogue.ts` 中 `mass_kg` 一行即可，无需重新下载。

### 再入日期的三个值，含义都不同

这是三源并列最必要的例子。以 **ISS（NORAD 25544）** 为证：

| 源 | 值 | 实际含义 |
|---|---|---|
| Space-Track `DECAY` | 空 | 在轨，未再入 — **正确** |
| DISCOS `predDecayDate` | 2026-05-12 | 预测再入 |
| Spacebook `GCAT DecayDate` | 1998 Dec 6 2347:02 | **ZARYA 舱段发射后分离时刻**，不是再入 |

Spacebook 这个值来自 GCAT 的发射记录，对多舱段组合体（ISS、天宫）记录的是舱段分离时间。
若只用 Spacebook，ISS 会被标成 1998 年就已再入。

**结论：`decay_date` 默认取 Space-Track；另外两个值保留但需按其真实含义解读。**

---

## 三源不一致统计（实测）

| 字段 | 多源都有 | 不一致 | 占比 | 性质 |
|---|---|---|---|---|
| object_class | 71,174 | 71,174 | **100%** | **分类体系不同**，非错误 |
| name | 71,087 | 69,349 | 97.56% | 大小写/连字符差异（`STARLINK-1007` vs `Starlink 1007`） |
| decay_date | 36,095 | 36,075 | 99.94% | 实测 vs 预测，且日期格式不同 |
| cross_section_avg_m2 | 37,623 | 37,582 | 99.89% | Spacebook 中位值 vs DISCOS 平均值 |
| inclination_deg | 67,741 | 53,785 | 79.40% | GCAT 记发射时值，ST 记当前值 |
| span_m | 36,993 | 128 | 0.35% | 基本一致 |
| cospar_id | 71,192 | 133 | 0.19% | 基本一致 |
| diameter_m | 12,654 | 2 | 0.02% | 一致 |
| **mass_kg** | 38,426 | **27** | **0.07%** | **两源实测一致** |

### 读法

- **object_class 100% 不一致**是必然的：Space-Track 4 类、DISCOS 12 类（细分到碎裂成因）、GCAT 5 类。这不是冲突，是粒度不同——这也是为什么三个值都要留。
- **inclination 79% 不一致**同理：GCAT 是 GCAT 的编目时刻，Space-Track 是当前时刻。
- **mass 仅 0.07% 不一致**，说明两源质量高度互证。

---

## 样例行

**NORAD 44713 — STARLINK-1007**

| 字段 | Space-Track | Spacebook | DISCOS | 采用 |
|---|---|---|---|---|
| name | STARLINK-1007 | STARLINK-1007 | Starlink 1007 | **spacetrack** |
| cospar_id | 2019-074A | 2019-074A | 2019-074A | spacetrack |
| object_class | PAYLOAD | — | Payload | **spacetrack** |
| country | US | — | — | spacetrack |
| launch_site | AFETR | — | — | spacetrack |
| launch_date | 2019-11-11 | — | — | spacetrack |
| decay_date | 2024-10-02 | 2024 Oct 2 1930? | — | spacetrack |
| inclination_deg | 53.04 | 53.01 | — | spacetrack |
| period_min | 88.35 | — | — | spacetrack |
| apogee_km | 198 | — | — | spacetrack |
| perigee_km | 187 | — | — | spacetrack |
| rcs_size | LARGE | — | — | spacetrack |
| mass_kg | — | 260 | 260 | discos |
| hard_body_radius_m | — | 1.138564 | — | spacebook |
| cross_section_avg_m2 | — | 7.225354 | 13.5615 | spacebook |
| cross_section_max_m2 | — | — | 23.657 | discos |
| cross_section_min_m2 | — | — | 0.2311 | discos |
| span_m | — | 8.86 | 8.86 | spacebook |
| ballistic_coefficient | — | 0.0611376 | — | spacebook |
| shape | — | — | Box + 1 Pan | discos |
| manufacturer | — | SPXS | — | spacebook |
| bus | — | Starlink | — | spacebook |
| orbit_type | — | LLEO/I | — | spacebook |
| dry_mass_kg | — | 248 | — | spacebook |
| length_m | — | 0.2 | — | spacebook |

**这一行说明了为什么必须三源并列**：
- 只有 Space-Track 知道它从 AFETR 发射、属于美国、轨道 53.04°
- 只有 Spacebook 知道它硬体半径 1.138 m、弹道系数 0.061、制造商 SPXS
- 只有 DISCOS 知道它是 `Box + 1 Pan` 形状、最大截面 23.657 m²

任一源单独拿出来，这一行都是残缺的。

---

## 后续

1. 宽表接入 `/objects` 页面，字段旁标明来源，可切换。
2. 用户选择写入 `__chosen`，可导出/导入。
3. 同一对象历史快照按抓取日期保留，形成时间序列。
