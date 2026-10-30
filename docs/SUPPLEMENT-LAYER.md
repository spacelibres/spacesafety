# 补充数据层（AI 辅助补全）

## 为什么需要单独一层

编目库里的每个数字都必须能回答：「谁说的、什么时候说的、依据是什么」。

三大源（Space-Track / Spacebook / DISCOS）满足这个要求，因为它们是**官方编目**，
有固定文件、有更新周期、可以逐字节复核。

AI 从互联网检索来的数据**不满足**这个要求：它可能来自厂商新闻稿，也可能来自论坛转述。
直接写进 `catalogue_wide` 会让人无法区分「美国太空军编目记载」和「某网站说」，
整个库的可信度就被拉平了。

所以补充数据进独立的一层，**默认不参与任何对外输出**，由人决定是否提升。

```
supplement_claim   AI 检索结果，带出处、原文、置信度，未审核
       ↓ 审核（人工确认或规则通过）
catalogue_wide.__supplement   第四来源列，与三源并列
       ↓ 用户选择
catalogue_wide.__chosen       最终对外采用的值
```

---

## 采信标准（用户已确认）

**只接受 A + B 级来源，且必须有实测佐证。**

| 级 | 来源类型 | 判据 |
|---|---|---|
| **A** | 厂商官网、FCC / ITU 备案文件、政府公告、航天机构（NASA/ESA/CNSA）官方发布 | 一手文件，可追溯到发布主体 |
| **B** | 有引用来源的专业媒体报道（SpaceNews、Spaceflight Now）、有引用的百科条目、技术论文 | 二手，但标明了原始出处 |
| **C** | 论坛、自媒体、无出处的聚合站、AI 自己推断 | **一律不采信** |

### 「实测佐证」的具体含义

A/B 级之外，还要求数值**有独立佐证**，不能是单一孤证：

- 质量：同时出现在厂商规格页与发射器能力表中，或与已知同级型号的实测值相符
- 尺寸：与同批次同型号卫星的已有记录一致（同一型号不应有不同尺寸）
- 制造商：**两个独立来源**指向同一主体

**只有单一来源的数字仍可入库，但标 `evidence_count = 1`，不参与自动提升。**

---

## 数据结构

```sql
CREATE TABLE supplement_claim (
  id            TEXT PRIMARY KEY,
  norad_id      INTEGER,
  -- 未编入 NORAD 的对象用 COSPAR 或名称定位
  cospar_id     TEXT,
  object_name   TEXT,

  field         TEXT NOT NULL,       -- manufacturer | bus | shape | mass_kg | ...
  value_num     REAL,
  value_text    TEXT,
  unit          TEXT,

  -- 溯源：缺任何一项都不入库
  source_url    TEXT NOT NULL,
  source_type   TEXT NOT NULL,       -- official | fcc | agency | press | encyclopedia | paper
  source_grade  TEXT NOT NULL,       -- A | B | C
  quote         TEXT NOT NULL,       -- 原文摘录，必须含依据
  retrieved_at  TEXT NOT NULL,

  -- 佐证
  evidence_count INTEGER NOT NULL DEFAULT 1,
  corroboration  TEXT,               -- 其他独立来源 URL，JSON 数组

  confidence    REAL NOT NULL,       -- 0..1
  verified      INTEGER NOT NULL DEFAULT 0,  -- 0 未审核 1 已确认 -1 已否决
  verifier      TEXT,
  note          TEXT
);
```

### 字段约束

| 字段 | 规则 |
|---|---|
| `source_url` | 必填，且必须能被复核（不是搜索结果页，是正文页） |
| `quote` | 必填，长度 ≥ 20 字符，必须含支撑该数值的原文 |
| `source_grade` | C 级**拒绝入库**，不是存了再过滤 |
| `confidence` | 来源等级 + 佐证数 + 原文明确度，三者加权 |
| `verified` | 默认 0，任何自动流程不得置 1 |

---

## 补什么：按对象类型区分

实测：在轨 35,460 个对象中

| 字段 | 在轨缺口 | 值得补吗 |
|---|---|---|
| 质量 | 114 | 否，缺口太小 |
| 硬体半径 | 115 | 否 |
| **形状** | **12,831** | 是 |
| **制造商** | **10,632** | 是 |
| **平台型号** | **13,444** | 是 |

### 但缺制造商的 10,632 个里，9,465 个是碎片

| 类型 | 缺制造商数 | 正确补法 |
|---|---|---|
| Debris | 9,465 | **不查制造商**。碎片没有制造商，只能追母体（解体事件、母体卫星） |
| Payload | 896 | 查制造商、平台型号、质量、尺寸 |
| Rocket Body | 42 | 查所属运载火箭型号 |
| Unknown | 227 | 先判类型再补 |

**对碎片查「制造商」在物理上就是错的**：它们来自某次解体，所有者为母体卫星的运营方。
碎片应补的是**母体与解体事件**，这是另一个字段集。

### 高价值目标：新发射卫星

缺制造商的对象中，大量是近几个月发射的新星（鸿雁、Starlink 新批次、HAWK）。
这类卫星的公开资料（厂商发布、FCC 备案）**比第三方编目库更新得快**，
是 AI 补充真正有价值的场景。

---

## 流程

1. **候选筛选**：从 `catalogue_wide` 取出缺字段的在轨对象，按发射日期倒序（新星优先，资料更易查证）
2. **检索**：按 `NAME + COSPAR` 检索，只采信白名单域名
3. **抽取**：要求模型返回 `{field, value, source_url, quote}`，**拿不到原文摘录就丢弃**
4. **定级**：依域名与发布主体判 A/B/C，C 直接丢
5. **佐证**：同一字段寻找第二个独立来源，写入 `corroboration`
6. **入库**：`verified = 0`
7. **审核**：人工确认后，方写入 `catalogue_wide.__supplement`

## 不可逾越的约束

- AI **不得**产生推断值（例如「看起来像 Starlink 所以质量也是 260 kg」）
- AI **不得**用已有对象的值外推到新对象
- 无 `source_url` 或 `quote` 的结果**直接丢弃**，不做「尽力而为」的填充
- 补充值**永不自动成为默认**，`__chosen` 必须由人指定或规则显式提升

---

## 待定

联网检索需要以下之一：

1. 搜索 API（Serper / Brave / Tavily / Bing）
2. 模型 API（OpenAI / Anthropic）配合抓取
3. 指定白名单站点的直接抓取（SpaceNews、Gunter's Space Page、FCC 数据库等）

在接口确定前，本层只做结构与规则，不做实际抓取。
