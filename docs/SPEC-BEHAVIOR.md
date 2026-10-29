# 服务行为规格（从官方文档提炼）

本文件是**实现依据**。凡是我们自己建的服务，其可观察行为必须与本文件一致。
每条都标注来源，便于溯源。

来源文档均在 `docs/starlink-space-safety/`。

---

## 1. 认证与授权

**采用 mTLS**（`api-keys.md`）：

- 客户端持有 `client.crt` + `client.key`（EC P-384 / SHA-384）。
- CSR 的 `CN` 唯一标识凭证，`O`/`OU` 为信息性元数据。
- 每个环境**分别签发**证书：staging 与 production 不通用。
- 超限返回 **HTTP 503**，按运营方维度限流。

派生到实现：
- 我方签发证书时应从 CSR 中读取 `O`（或约定的映射表）绑定到 Operator。
- 一个 Operator 可有多个凭证；凭证可吊销。
- 未携带/不可信证书 → `403 RBAC: access denied`（官方 staging 实测返回该文案）。

---

## 2. 实体关系

```
Operator 1---N Object 1---N Trajectory
                  \            /
                   N--- CDM ---N   （CDM 关联两条 Trajectory）
                        |
                        N
                    1 Event          （CDM 多对一归属 Event）
```

- **Operator**：`id, name, email, phone, max_objects`
- **Object**：`id, operator_id, object_name, norad_id?, hard_body_radius(≤512m), maneuverability, alive`
- **Trajectory**：状态点序列（位置/速度/时间/协方差）+ `upload_type` + `state_source` + `screened_status`
- **CDM**：CCSDS 标准交会数据消息，**每对落入筛查盒的轨迹都生成**（即使 Pc=0）
- **Event**：TCA 相差 **20 分钟**内的 CDM 归入同一事件

---

## 3. 轨迹上传语义（`tutorial-basics/trajectories.md`）

三种 `upload_type`：

| 类型 | 是否入 Catalog | 可见性 | 是否产生 Event |
|---|---|---|---|
| `definitive` | ✅ 替换该对象旧 definitive | 全平台 | ✅ |
| `hypothetical` | ❌ 仅筛查一次 | 仅提交方 | ❌ 只产 CDM |
| `candidate` | 所有 CDM 低于阈值则**转为 definitive** | 全平台 | ✅ |

**校验规则（违反 → 400）**：
- 未来状态点 ≥ 6 个
- 跨度 ≥ 42 秒 且 ≤ 21 天
- 每个状态点须有协方差；位置协方差非零；协方差半正定
- 速度 ≤ 70 km/s；位置不得低于地表
- 时间系统仅 **UTC**；CCSDS 仅 **KVN**

**支持的参考系**：
- 位置/速度：`ITRF`、`EME2000`
- 协方差：`RTN`、`ITRF`、`EME2000`（未给出 `COV_REF_FRAME` 时默认与位置同系）
- **ITRF 为系统原生帧**

**支持格式**：OEM、OCM、Modified ITC、JSpOC、UTC、NASA（按文件头自动判别）

**`screened_status`**：
`not_screened` → `screened` | `superseded` | `failed_interpolation` | `unknown_trajectory_fetching_error` | `candidate_to_definitive`

> 同一对象同一筛查周期有多个 definitive 时，只筛查**最新**（按上传时间），其余置 `superseded`。

---

## 4. 筛查引擎

### 4.1 Catalog
每个对象的每个 `state_source` 只保留**最新 definitive** 轨迹。

### 4.2 筛查周期
队列模型：新轨迹入队 → 流水线批量取 `not_screened` → 对 Catalog 筛查 →
生成 CDM → 更新 Event → 更新轨迹状态 → 刷新 Catalog。
官方称"通常 < 1 分钟出结果"。

### 4.3 近距接近判定（筛查盒）
RTN 坐标系下，半宽：

| 方向 | 半宽 |
|---|---|
| R（径向） | **2 km** |
| T（沿轨） | **44 km** |
| N（离轨） | **51 km** |

- 盒的朝向由各自对象的速度确定（RTN 随速度旋转）
- **双向判定**：A 的盒 ∩ B 轨迹，或 B 的盒 ∩ A 轨迹
- 近距接近 = 落在筛查盒内的**相对距离局部极小值**

### 4.4 碰撞概率
**二维 Alfano 方法**（*A Numerical Implementation of Spherical Object Collision Probability*, Alfano, 1994, DOI 10.1007/BF03546397）。

边界条件（`tutorial-basics/cdms.md`）：
- 两条轨迹**都有**协方差 → 计算 Pc
- 任一方缺协方差，或协方差非半正定 → CDM 仍生成但 `COLLISION_PROBABILITY = NULL`，
  并附注释：
  `COMMENT_FAILED_COLLISION_PROBABILITY_CALCULATION_ALFANO = Collision probability calculation failed.`
  此时 CDM 仍包含相对脱靶矢量

### 4.5 Event 归属
CDM 的 TCA 与已有 Event 相差 ≤ **20 分钟** → 归入该 Event，否则新建。
（低相对速度下 TCA 可能漂移 > 20 min，导致同一接近产生多个 Event，这是已知且允许的。）

### 4.6 CDM 活跃性（`is_active`）
新生成时为 `true`。以下情况置 `false`：
- 同一 Event、**同一 state source 组合**产生了更新的 CDM
- 更新的同 source 轨迹被筛查且**未**产 CDM（最近距离落在筛查盒外）

> 同一 Event 可同时存在两条 active CDM：`operator_ephemeris vs operator_ephemeris`
> 与 `operator_ephemeris vs spacex_optical`。

---

## 5. State Source（`tutorial-basics/stargaze.md`）

| 值 | 含义 |
|---|---|
| `operator_ephemeris` | 运营方提交的星历 |
| `spacex_optical` | 基于 Stargaze 光学观测的轨迹 |

可见性规则：
- 可查看**所有** `operator_ephemeris` 轨迹的元数据与其 CDM/Event
- 可查看 `spacex_optical` 针对自己的星历产生的 CDM/Event/元数据
- **不可**直接查看 `spacex_optical` 轨迹内容

---

## 6. 分页与流式（`api-patterns.md`、各端点文档）

所有"批量"端点使用 **token 流式分页**：

- `GET /v1/trajectory`：按 `uploaded_at_utc` 然后 `id` 排序
- `GET /v2/cdm`：按 CDM **创建时间**排序；CDM 不可变，故每条只出现一次
- `GET /v2/trajectory/:id/cdms`：同上

规则：
- **即使返回 0 条，也应复用同一 token**，下次拿到增量
- token 过期 → `400`，`error_type = "pagination_too_old"`，客户端必须清空 token
- 改变过滤参数但复用同一 token，行为**未定义**
- `GET /v2/cdm` 至少要提供 `operator1_id`、`trajectory_id`、`object1_id` 之一
- `hypothetical` 产生的 CDM **不进入** `/v2/cdm` 流

---

## 7. 错误响应

```json
{
  "correlation_id": "string",
  "error": "string",
  "error_type": "string",
  "metadata": {}
}
```

- `400` 参数错误 / `pagination_too_old`
- `404` 资源不存在
- `500` 内部错误
- `503` 限流

---

## 8. 我们刻意做出的取舍（实现说明）

以下不是官方规范，而是我方实现在官方未公开细节处的合理选择：

1. **数值内核**：实现 RTN 旋转、SGP4 级二体/J2 传播、Alfano 二维 Pc。
   官方传播器未公开，我们以二体+J2 近似，并在文档中明确标注精度边界。
2. **Stargaze**：无光学观测数据源，`spacex_optical` 轨迹由"模拟观测"模块生成，
   或直接停用该 source（配置开关）。
3. **限流**：按官方 503 语义实现，阈值可配。
4. **Web UI**：官方 UI 细节未全部公开，我们按文档描述重建同类页面
   （operator/object/trajectory 详情、事件详情、预测精度图）。
