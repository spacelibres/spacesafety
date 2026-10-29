# 变更日志

本项目的版本号是**严格递增的补丁版本**：每一次进入版本库的迭代都递增最后一位
（`0.1.0` → `0.1.1` → `0.1.2` …）。版本号同时写在 `package.json` 与对应的 git tag 上，
两者必须一致。

记录规则：

- 每条目写清「为什么改」，而不只是「改了什么」；
- 影响计算结果、剪枝策略或数据格式的改动，必须写明验证方式；
- 已知问题单列，不藏在「修复」里。

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
