# 变更日志

本项目的版本号是**严格递增的补丁版本**：每一次进入版本库的迭代都递增最后一位
（`0.1.0` → `0.1.1` → `0.1.2` …）。版本号同时写在 `package.json` 与对应的 git tag 上，
两者必须一致。

记录规则：

- 每条目写清「为什么改」，而不只是「改了什么」；
- 影响计算结果、剪枝策略或数据格式的改动，必须写明验证方式；
- 已知问题单列，不藏在「修复」里。

---

## [0.1.5] - 2026-10-29

按 spacelibre VI 标准重做配色，并把轨道视图从"一个黑球加一堆线"改成真正的地球视图。

### 新增

- **VI 规范落地**（`CONTRIBUTING.md` 新增第 9 节，来源 github.com/spacelibres/vi）：
  - `src/lib/vi/palette.ts` 是唯一颜色来源，采用预设 `01-electric-orbit`
    （primary `#007BFF`，与 logo 母版一致）。
  - `tools/vi.ts` 从调色板生成 `src/app/vi-tokens.css` 与 `public/vi/*.svg`，
    颜色一律由生成，禁止手写十六进制值。
  - Logo 使用 VI 的真实矢量母版（`design/vi-source/`，逐字节保留），
    单色母版不做任何改色；全彩母版按主题重着色星球（深色 `#FF3733` / 浅色 `#E00400`），
    蒙版结构色 black/white 保持不变。
  - 12 组对比度全部 ≥ 4.5:1。VI 的状态色原本是按白纸设计的，在深色背景上只有 2.9:1，
    新增 `legibleOn()` 自动推导最接近的可读版本，而不是另造一套"暗色专用色"。
- **地球视图**：
  - 透明球体 + 15° 间隔经纬网格（赤道与本初子午线加粗）。
  - 177 个国家边界（Natural Earth 1:110m，公有领域）。
  - 国名标注，六语种取自 Natural Earth 自带的 `NAME_ZH/EN/ES/FR/DE/JA` 列，
    无需手工翻译；标注按屏幕包围盒去重，面朝相机者优先，不会重叠。
  - 太阳与月亮按真实地心方向放置（Meeus 算法，太阳 ~0.01°，月亮 ~0.3°），
    光照方向与所绘太阳一致；另有 1800 颗确定分布的星空。
  - 鼠标悬停读取球面经纬度，按度分秒格式化显示。
- **偏好设置**：语言与外观移到侧栏左下角，默认均为「跟随系统」
  （语言读 `navigator.languages`，外观读 `prefers-color-scheme`），也可手动指定。
- 新增 `npm run vi`（生成 VI 资源）、`npm run fetch:geo`（下载国界数据）。

### 修复

- `stats-row`、`home-grid`、`sidebar-language`、`sr-only` 等类被页面引用但**从未定义**，
  统计卡片竖排、轨道视图占满整行、语言选择器文字重叠。
- 浅色主题失效：`:root` 与 `[data-theme="light"]` 特异性相同，浅色规则被覆盖。
  改为 `:root[data-theme="light"]`，不再依赖源顺序。
- Next.js 开发指示器浮标压住左下角偏好区，已在 `next.config.ts` 关闭。
- 轨道过密导致地球被完全遮住（60 条 181 点折线叠在 1.05 地球半径内）：
  改为 2 条完整轨道 + 其余降采样为背景点云。
- 国名标注互相重叠（Chile/Bolivia/Paraguay 叠在一起）：加入屏幕空间碰撞剔除。

### 验证

- `tsc --noEmit` 0 错误；23 个测试套件 43 条断言全过；`npm run check` 9 项全过。
- 7 个页面全部 200；zh-CN / ja / de 下界面文案与国名均正确切换。
- 截图核对：地球轮廓、国界、国名、太阳、经纬度读数、左下角偏好区均正常。

---

## [0.1.4] - 2026-10-29

新增项目规则、六语种界面，并把全部工具从 Python 迁到 TypeScript。

### 新增

- **`CONTRIBUTING.md`**：约束性项目规则——技术栈（TS + Next.js + Three.js）、
  面向对象开发标准、脚本必须用 TS、多语言要求、版本与提交规则、仓库内容规则、
  提交前必跑的三项检查。规则的修改也要走版本流程。
- **多语言（zh-CN / en / es / fr / de / ja）**：
  - `src/lib/i18n/` 提供 `Translator` 类（`t`/`number`/`dateTime`/`probability`），
    274 个键 × 6 个语种；缺失键在提交前由检查器拦下，而不是运行时静默回退。
  - 语言由 `locale` cookie 决定，服务端渲染 `<html lang>` 与文案，侧栏有切换器。
  - 技术标识（对象名、CCSDS 字段名、单位、API 路径）按规范不翻译。
- **`tools/check.ts`**：提交前自检 8 项——无 Python 残留、`.gitignore` 无危险规则、
  计算内核已入库、无凭据/数据入库、六语种键一致、页面引用的键都存在、
  版本四处一致、无硬编码界面文案。

### 变更

- `tools/*.py`（8 个文件、1 341 行）全部重写为 TypeScript 并接入 `npm run`：
  `serve`、`fetch:ephemeris`、`fetch:docs`、`fetch:screenshots`、`ingest:all`、
  `probe:manifest`、`probe:screen`、`check`。新增 `tools/lib/downloader.ts`（SOCKS5
  下载、整文件完整性校验）与 `tools/lib/chrome.ts`（无头 Chrome 渲染）。
- `probe:screen` 补上了原先只有 Python 版才有的采样点统计与耗时分布。

### 修复

- 下载工具读的是裸 `PROXY` 且默认硬编码本地端口，`.env.local` 的
  `SPACE_SAFETY_PROXY` 被静默忽略；现改为读文档化变量名，默认直连。
- `client.tsx` 曾从 `registry.ts` 导入，而后者用了 `next/headers`，
  导致所有页面编译失败（500）。已把字典与工厂函数拆到 `tables.ts`。
- 并行编辑曾把 39 个字典键从**所有**语种同时删掉，`i18n` 检查因六语种仍然互相
  一致而未能发现，页面直接把键名渲染成标题。已补回，并新增 `i18n-missing-key`
  检查专门覆盖这一类。
- `PcHistoryChart` 改为必须在 Provider 内才能渲染，导致图表轴测试失败；
  现在缺少上下文时回退到默认语言而不是抛错。

### 验证

- `npx tsc --noEmit`：0 错误。
- `npm test`：23 个套件、43 条断言全部通过。
- `npm run check`：8 项规则检查全部通过（274 键 × 6 语种）。
- 实测 7 个页面在 zh-CN / en / ja 下均返回 200，标题与表头正确本地化。

---

## [0.1.3] - 2026-10-29

修复 **v0.1.1 与 v0.1.2 的仓库缺少计算内核**。

### 修复

- `.gitignore` 中为忽略崩溃转储而写的裸 `core` 规则，把 `src/lib/core/`
  整个目录一并忽略——`screening.ts`、`alfano.ts`、`propagator.ts`、
  `time-windows.ts` 等 10 个文件从未进入版本库。克隆该仓库无法编译，
  且 `git status` 不会提示，因为文件被当作「有意忽略」。
  改为带锚点的 `/core`、`/core.*`、`/core.[0-9]*`。
- 移除误入库的 `tools/__pycache__/*.pyc`，并在 `.gitignore` 补充 Python 字节码规则。

### 验证

- `git ls-files src/lib/core` 现在列出全部 10 个内核文件。
- 本地源码 135 个文件与入库文件逐一比对，无遗漏。
- `tsc --noEmit` 无错误；23 个测试套件全过。

---

## [0.1.2] - 2026-10-29

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
