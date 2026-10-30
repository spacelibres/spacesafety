# 数据源盘点

**结论先行**：下载了 29 类数据，其中 **14 类从未入库**（约 90 MB），包括
Space-Track 官方再入预测 26,184 条、公开 CDM 3,161 条、DISCOS 碎片事件 673 条。
这些不是无用的副产物，正好补上编目里最缺的几块。

生成时间：2026-10-30（每日刷新后复核）

---

## 一、四个编目源（已入库）

| 源 | 表 | 行数 | 官方定位 | 抓取时间（UTC）|
|---|---|---|---|---|
| Space-Track SATCAT | `space_track_satcat` | 71,198 | 美国太空军第 18 太空防御中队 | 10-30 09:47 |
| Spacebook SATCAT | `satcat` | 72,310 | AGI/STK | 10-30 09:48 |
| ESA DISCOSweb | `discos_objects` | 71,176 | 欧空局 | 10-30 09:47 |
| KeepTrack | `keeptrack_object` | 35,203 | keeptrack.space（编译型参考） | 10-30 09:52 |

刷新后宽表 72,402 行（+1），五源覆盖与定稿逐项一致，见 `docs/CATALOGUE-FINAL.md`。

### Spacebook 的两个附属表

| 表 | 行数 | 内容 | 备注 |
|---|---|---|---|
| `object_physics` | 71,074 | COMSPOC 推导物理模型 | **唯一提供硬体半径** |
| `object_launch_info` | 69,918 | GCAT 发射记录（McDowell） | 制造商、平台、干重 |

**注意**：`object_physics` 中 31,879 个碎片带占位值（5 kg / 5 m / 10 m 翼展），
已在宽表中清除，见 `docs/WIDE-CATALOGUE.md`。

---

## 二、KeepTrack 五类数据（已入库）

| 表 | 行数 | 内容 |
|---|---|---|
| `keeptrack_object` | 35,175 | 编目 + 物理字段 |
| `keeptrack_conjunction` | 10 | **SOCRATES 交会筛查** |
| `keeptrack_reentry` | 14 | 预测再入 |
| `keeptrack_launch_stat` | 4,069 | 发射统计（年度/火箭/发射场/月度） |
| `keeptrack_upcoming_launch` | 100 | 即将发射 |

---

## 三、下载了但从未入库（14 类，约 90 MB）

这是本次盘点的核心发现。每一类都有明确用途。

### 3.1 高价值：立即应入库

| 归档 | 体积 | 条数 | 内容 | 为什么重要 |
|---|---|---|---|---|
| `space-track-tip` | 7.9 MB | **26,189** | 官方再入预测：`DECAY_EPOCH` `WINDOW` `LAT` `LON` `INCL` `NEXT_REPORT` | KeepTrack 只有 14 条；这是官方全量，带落点与置信窗口 |
| `space-track-cdm-public` | 1.3 MB | **3,164** | 公开 CDM：`TCA` `MIN_RNG` `PC` `SAT_1/2_ID` `EXCL_VOL` | **官方碰撞告警**，含实际碰撞概率 |
| `space-track-decay` | 42 MB | — | 再入历史明细 | 补 `decay_date` 的官方依据 |
| `discos-fragmentations` | 476 KB | **673** | 碎裂事件：`epoch` `latitude` `longitude` `altitude` `eventType` | **碎片来源**——碎片该补的不是制造商，是母体事件 |
| `discos-launches` | 4.6 MB | 7,379 | 发射记录：`epoch` `flightNo` `cosparLaunchNo` `failure` | 发射批次与失败标记 |
| `space-track-boxscore` | 48 KB | 122 | 按国家统计在轨/已再入载荷、碎片数 | 编目概览与对外展示 |

### 3.2 中等价值：辅助字段

| 归档 | 体积 | 条数 | 内容 |
|---|---|---|---|
| `space-track-launch-site` | 12 KB | 45 | `SITE_CODE` → 发射场名称（把 `AFETR` 变成「Cape Canaveral」） |
| `spacebook-eop` | 2.4 MB | — | 地球定向参数，推算坐标系转换用 |
| `spacebook-spaceweather` | 3.4 MB | — | 空间天气，大气阻力与轨道衰减相关 |

### 3.3 星历类：按需，不急于入库

| 归档 | 体积 | 条数 | 说明 |
|---|---|---|---|
| `space-track-gp` | 11 MB | — | GP 根数（TLE 已入 `trajectories`） |
| `spacebook-omm-json/kvn/xml` | 100 MB | — | 三种格式同一数据，已验证记录集合完全相同，**只保留一份即可** |
| `spacebook-xp-tle` | 4.0 MB | — | 已确认为 LEGACY，历元落后 66 小时 |
| `discos-orbits` | 31 MB | 87,378 | 平均根数（`sma` `ecc` `inc`…），**历元多为发射时**，只作历史参考 |
| `spacebook-entity-tle` | 4.4 MB | — | 已入 `trajectories` |

---

## 四、两条并行路径的问题

### `object_field_claim` 是空表

这张表是为「保留各家原值」建的，设计上应该在合并时写入。实测 **0 行**——
说明合并流程从未调用它，而宽表是从归档文件直接读的。

后果：宽表有值，但那套「逐字段出处」机制没有被使用。

**建议**：要么让 `master:build` 写入 claim，要么废掉该表并由宽表承担。
两条路径并存是隐患。

### 各源的更新频率（调度依据）

| 源 | 端点 | 官网更新频率 | `downloads.ts` |
|---|---|---|---|
| Space-Track | GP | **每 2 小时** | 120 min |
| Space-Track | public CDM | 每 1 小时 | 60 min |
| Space-Track | TIP（再入预测）| 6 小时 | 360 min |
| Space-Track | SATCAT / decay / boxscore / launch-site | **每日** | 1440 min |
| Spacebook | OMM (json/kvn) / entity-TLE / xp-TLE / supplemental | **每 2 小时** | 120 min |
| Spacebook | SATCAT / details / CSV / OMM-XML / EOP / 天气 | **每日** | 1440 min |
| KeepTrack | 编目 + 五类 feeds | **每日** | 由 `data-schedule` 每日判定 |
| DISCOS | objects / launches / fragmentations | 不定期 | 1440 min |
| DISCOS | reference / launch-vehicles / orbits | 近乎静态 | 10080 min |

频率只写在 `src/lib/sources/downloads.ts` 一处，调度器读它而不是重复一遍。

#### 没有更新的数据不重新下载

这是四层判断，**每一层能省的东西不一样**，不能混着说：

| 层 | 依据 | 省下什么 | 现状 |
|---|---|---|---|
| 节奏 | `downloads.ts` 的 `refreshMinutes` + `source_fetches` 上次检查时间 | 整次请求（连 HEAD 都不发） | 已生效 |
| 条件请求 | `if-none-match` / `if-modified-since`（上一轮的 validator） | 响应主体（`304`，0 字节） | 机制已就绪，**当前四个源都不发 validator** |
| 压缩 | `accept-encoding: gzip` | 传输量约 4 倍 | 已生效 |
| 归档 | 与上一份 SHA-256 相同 | 不写新档（磁盘） | 已生效 |
| 重建 | 本轮 `source_fetches.status='ok'` 的行数 | load → wide → classify → events | 已生效 |

**当前四个源的实测响应头（2026-10-30，直接用 node fetch 打）：**

| 端点 | ETag | Last-Modified | cache-control |
|---|---|---|---|
| `spacebook.com/api/eop/full` | 无 | 无 | `no-store,no-cache` |
| `spacebook.com/api/entity/omm/json` | 无 | 无 | `no-store,no-cache` |
| `www.space-track.org` | 无 | 无 | `no-store,no-cache,must-revalidate` |
| `discosweb.esoc.esa.int` | 无 | 无 | 无 |

**结论要说清楚：条件请求的收益目前是 0 字节。** 服务器不发 `ETag` / `Last-Modified`，
客户端就没有东西可以拿回去比对，每次仍然是完整响应。机制保留是因为：
一旦上游（或中间的 CDN）开始发 validator，这一层立刻生效，不需要改代码；
而且它没有代价——不发 validator 时不加条件头，行为与以前完全一致。

**真正省下带宽的是压缩。** `src/lib/net/encoding.ts` 里的 `ACCEPT_ENCODING`
（`gzip, deflate`）被**每个出口**使用：`download()`、旧 `EphemerisDownloader` 的
fetch 与 SOCKS5 两条分支、DISCOS 分页爬取、KeepTrack 全量与五类 feeds、网页抓取。

不提 brotli 是实测结论。undici 默认会协商到 brotli，而在这里它是更差的选择：

| 请求头 | 传输 | 耗时 |
|---|---|---|
| `identity` | 30.37 MB | 7.2 s |
| `gzip` | **7.23 MB** | **1.3 s** |
| `br`（原来协商到的） | 8.59 MB | 2.5 s |

**12 个 Spacebook 端点逐个实测（2026-10-30，curl 计 `size_download`）：**

| 端点 | 未压缩 | gzip | 压缩比 | 节奏 | 原 MB/日 | 现 MB/日 |
|---|---|---|---|---|---|---|
| `entity/omm/json` | 30.37 | 7.23 | −76% | 2 h | 364 | **87** |
| `entity/omm/kvn` | 25.31 | 25.31 | 0% | 2 h | 304 | 304 |
| `entity/omm/xml` | 48.24 | 48.24 | 0% | 1 d | 48 | 48 |
| `entity/tle` | 4.60 | 4.60 | 0% | 2 h | 55 | 55 |
| `entity/xp-tle` | 4.15 | 4.15 | 0% | 2 h | 50 | 50 |
| `entity/satcat` | 21.18 | 5.72 | −73% | 1 d | 21 | **6** |
| `entity/satcat/details` | 69.42 | 12.33 | −82% | 1 d | 69 | **12** |
| `entity/satcat/supplemental` | 14.82 | 3.37 | −77% | 2 h | 178 | **40** |
| `entity/satcat/csv` | 11.24 | 11.24 | 0% | 1 d | 11 | 11 |
| `entity/satcat/details/csv` | 24.12 | 24.12 | 0% | 1 d | 24 | 24 |
| `spaceweather/full` | 3.47 | 3.47 | 0% | 1 d | 3 | 3 |
| `eop/full` | 2.48 | 2.48 | 0% | 1 d | 2 | 2 |
| **合计** | | | | | **1131** | **644** |

**每日 1.13 GB → 0.63 GB，省 43%（约 0.5 GB/日）。**

只有 5 个端点会压缩，8 个端点不发 `content-encoding`（`omm/kvn` 试过 `br` 也不行）。
所以**节省比例由端点的服务端决定，不是客户端能选的**。
下表里的 `approxMB` 是**解压后**大小，从来不是线路传输量。

### 顺带发现的浪费：同一份元素集取了三遍

上表里 `omm/kvn` 是单笔最大开销（**304 MB/日**），而它和 `omm/json`
（87 MB/日）、`omm/xml`（48 MB/日）是**同一批 OMM 记录的不同序列化**——
三种编码合计 439 MB/日，占当前 644 MB/日的 68%。kvn 与 xml 存在的理由是
"确认字段集与格式无关"（见 `downloads.ts` 的 `purpose`），不是最新鲜的数据源。

**没有擅自改频率**：节奏是你定的，而且 kvn 服务端不压缩这一点也不是客户端的错。
如果要省这 300 MB/日，最直接的一步是把 `spacebook-omm-kvn` 从 2 h 降到 1 d
（改 `downloads.ts` 一个字段），全量降到约 **365 MB/日**。这一步要不要做，等你决定。

validator 存在 `source_fetches.etag` / `source_fetches.last_modified`，
由 `SourceLedger.lastValidators()` 读出、`finish()` 写回；
`--force` 时不发送条件头（否则服务器回 304 就把手工强制刷新吃掉了）。

`source_fetches.status` 因此有四个值：`ok`（有新字节）/ `unchanged`（304 或同哈希）/
`failed` / `running`。判断是否到期用 `status IN ('ok','unchanged')`——两者都算"检查过了"；
只有 `ok` 才触发重建。

验证不连上游：`tests/http-conditional.test.ts` 起本地 `node:http` 文件服务，
断言第二次请求是 `304` 且写入 socket 的主体字节为 **0**。

**三维模型不在此表内**：299 个 `.glb` 变动极少，不参与每日刷新
（需要时手动 `npm run models:sync`）。

调度的两种用法：

```bash
npm run data:schedule -- --status   # 看每个端点：频率 / 上次成功 / 是否到期
npm run data:schedule -- --once     # 跑一轮（systemd timer 调的就是这个）
npm run data:schedule -- --loop     # 常驻，每 10 分钟自检一次
```

**开发期不装自动调度**（2026-10-30 决定）：后台自动改数据会让本地测试状态不可控。
需要时手动 `npm run data:schedule -- --once`。

上线时再启用 systemd 用户级 timer（unit 文件已备好）：

```bash
systemctl --user link "$PWD/deploy/systemd/spacesafety-data.service"
systemctl --user link "$PWD/deploy/systemd/spacesafety-data.timer"
systemctl --user enable --now spacesafety-data.timer
journalctl --user -u spacesafety-data -f
```

每 10 分钟自检不是数据频率——它是"什么时候去问频率"的节奏。没到期的端点连下载都不会
发起，一轮没有变化就退出，不重建。

### 数据新鲜度不一致

| 源 | 最后抓取 | 官方更新频率 |
|---|---|---|
| Space-Track | 10-29 18:03 | GP 每 2 小时，SATCAT 每日 |
| Spacebook | 10-29 18:04 | OMM/entity-tle 每 2 小时 |
| DISCOS | 10-29 18:39 | 不定期 |
| KeepTrack | 10-30 11:29 | 每日 |

**开发期不装调度**，靠手动运行脚本（上线时用 `deploy/systemd/` 的 timer）。每日流程见 `docs/CATALOGUE-FINAL.md` §七，
**不要**把 `npm run catalogue:build` 放进这条流程：它会用工作库重建 `catalogue.sqlite`，
而 `keeptrack_object` 等表只存在于 `catalogue.sqlite`，重建后即丢失（2026-10-30 实测踩到）。
`catalogue:build` 是"生成对外发布用的小库"，不是每日刷新的步骤。

---

## 五、建议的下一步（按价值排序）

1. **入库 `space-track-cdm-public`（3,161 条）** —— 官方碰撞告警，是平台核心业务
2. **入库 `space-track-tip`（26,184 条）** —— 官方再入预测全量
3. **入库 `discos-fragmentations`（673 条）** —— 补上碎片的母体信息
4. **建自动调度** —— 按各源更新频率定时抓取，否则数据会越来越旧
5. **统一 `object_field_claim` 与宽表的关系** —— 消除双路径
6. `space-track-boxscore`、`launch-site` 等小表随手入库

---

## 六、尚未触及的源

| 源 | 状态 |
|---|---|
| **LeoLabs** | 有商业 API，未申请密钥。提供高精度 LEO 编目与碰撞预警 |
| **CelesTrak** | KeepTrack 已代理其 TLE 与 SOCRATES；可直连补充 |
| **Spacebook `/api/Model`** | **已接入**：42 个公开 `.glb` 三维模型，表 `spacebook_model` |
| **Spacebook `/api/Scene` `/api/UserEphemeris`** | **实测为空数组**，非授权问题：这两个是用户上传内容，本账号无上传。见下 |

---

## 七、Spacebook 授权实测（2026-10-30）

Auth0 只允许 `authorization_code` 授权，`password` / `device_code` / `client_credentials` 全部被拒，
所以必须浏览器授权一次。

授权后实测：

| 端点 | 状态 | 实际内容 |
|---|---|---|
| `/api/Model` | 200 | **42 个公开模型**（`id` `filename` `name` `isPublic`） |
| `/api/Scene` | 200 | **空数组** |
| `/api/UserEphemeris` | 200 | **空数组** |

后两个是用户上传内容（`User` 前缀已暗示），本账号从未上传，故为空。
**此前文档写「三者都需浏览器授权」对 `Model` 正确、对另两个错误。**

### token 无法续期

请求带了 `offline_access`，但 Auth0 返回 `scope: openid profile email`，**未发 refresh token**，
token 24 小时后失效且不能自动续期。这是租户对该客户端的限制，我们改不了。

模型清单只有 42 条且极少变动，实际做法是：token 有效时抓一次并缓存。
