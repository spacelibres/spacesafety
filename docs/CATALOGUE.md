# 编目数据库

本文件说明 `data/catalogue.sqlite` 是什么、里面有什么、每个数字从哪来。

编目库是**独立文件**，只有 187 MB，与 57 GB 的星历工作库完全分离。它回答一个问题：
**我们有哪些空间物体，每个物体我们知道多少。**

## 构建与检查

```bash
npm run catalogue:build     # 从工作库导出编目库（不改动源库）
npm run catalogue:report    # 打印覆盖率报告
npm run catalogue:build -- --verify-only
```

应用通过 `.env.local` 中的 `SPACE_SAFETY_DB=./data/catalogue.sqlite` 只读这一个文件。

## 三层结构：观测 / 合并 / 计算

数字的来源不同，可信度不同，**不可混用**。

| 层 | 表 | 含义 | 引用时怎么说 |
|---|---|---|---|
| 观测 | `satcat` `space_track_satcat` `discos_objects` `object_physics` `object_launch_info` | 各数据源**原文**，一个源一份，互不覆盖 | 「Spacebook 说质量是 X」 |
| 合并 | `master_object` `master_element_set` `master_conflict` | 我们按优先级规则**选定**的那一个值 | 「编目认定质量是 X」 |
| 计算 | `derived_state` | 从合并值**算出来**的，可随时重算 | 「由此计算得 X」 |

`master_conflict` 记录三源打架且我们无法裁决的 54 条，不是错误，是待查清单。

## 三个数据源

| 源 | 表 | 记录数 | 定位 |
|---|---|---|---|
| Space-Track SATCAT | `space_track_satcat` | 71,198 | 身份权威：COSPAR、国家、发射场 **100% 覆盖** |
| Spacebook SATCAT | `satcat` | 72,310 | 覆盖面最广，带状态与协方差窗口 |
| ESA DISCOSweb | `discos_objects` | 71,176 | 质量与形状的**实测**来源 |
| Spacebook 物理模型 | `object_physics` | 71,074 | COMSPOC 推导模型，**唯一提供硬体半径** |
| Spacebook 发射信息 | `object_launch_info` | 69,918 | McDowell 发射记录：制造商、平台、干重、尺寸 |

## 合并优先级

| 字段 | 第一优先 | 兜底 | 理由 |
|---|---|---|---|
| 质量 | DISCOS（实测） | `object_physics` | DISCOS 覆盖仅一半，物理表补足到 98% |
| 横截面积 | DISCOS | 物理表中位值 | 同上 |
| **硬体半径** | `object_physics.hbr_mean_m` | 无 | **只有它有**；RCS 分级不是半径 |
| 形状 | DISCOS | McDowell | DISCOS 用文字，物理表用数字分类 |
| 身份 | SATCAT | — | 100% 覆盖 |

## 当前覆盖率（`npm run catalogue:report` 实测）

总数 72,311；在轨 36,570（50.57%）；已再入 35,741（49.43%）。

| 字段 | 在轨占比 | 全库占比 |
|---|---|---|
| 名称 / NORAD | 100.00% | 100.00% |
| COSPAR / 发射国 / 发射日期 / 发射场 | 96.96% | 98.46% |
| 目标分类 | 96.64% | 98.30% |
| 质量 / 硬体半径 / 横截面积 / 弹道系数 | 96.65% | 98.29% |
| 轨道类型 | 93.45% | 96.66% |
| RCS 分级 | 92.53% | 80.53% |
| 制造商 | 67.89% | 63.96% |
| 平台型号 | 60.20% | 52.91% |

**为什么统计算在轨和全库两个数**：全库百分比被 35,741 个已再入物体拉低，它们本来就不该有物理模型。
只看全库会误判为「缺三分之一」，只看在轨会掩盖历史数据缺口。

## 已知缺口（1,226 个在轨对象无物理模型）

| 类别 | 数量 | 说明 |
|---|---|---|
| Unknown（多为 Analyst Sat） | 1,143 | 未编目观测目标，**任何源都没有物理参数**，属正常 |
| Payload | 73 | 2026-10 刚发射（Starlink、鸿雁），模型尚未入库，属时间差 |
| Rocket Body / Debris | 10 | 同上 |

真正的缺口是 **73 个新发射 Payload**，随 Spacebook 更新自动补齐。

## 已修正的两处严重错误

| 问题 | 错误值 | 真实值 | 影响 |
|---|---|---|---|
| Starlink 硬体半径 | 8.83 m（实为**翼展**） | 1.14 m | 碰撞截面差 **60 倍** |
| ISS 硬体半径 | 5.0 m（RCS 分级估算） | 36.49 m | 差 14.6 倍 |
| 主库质量 | 只有 DISCOS，38,427 条 | 合并物理表，**71,075 条** | 32,648 个对象曾无质量 |

## 维护

- 新增一个下载端点时，**必须同时确认有导入器**。`object_physics` 与 `space_track_satcat` 都曾下载数天而无人解析。
- 改合并规则后跑 `npm run master:build` 再 `npm run catalogue:build`，最后 `npm run catalogue:report` 对比覆盖率。
- 源库 `data/spacesafety.sqlite` 不会被 `catalogue:build` 写入，可放心重跑。
