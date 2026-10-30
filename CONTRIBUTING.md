# Space Safety 项目规则

本文件是项目的**约束性规范**。任何代码改动、提交、发布都必须满足这里的条款；
与之冲突的实现不予合入。规则的修改本身也需要走版本流程，并写入 `CHANGELOG.md`。

版本：这一版对应 `0.1.63`。

---

## 1. 技术栈（硬性）

| 层 | 技术 | 约束 |
|---|---|---|
| 语言 | **TypeScript** | 全仓库只用 TS。禁止新增 Python、Shell 业务脚本、.mjs 工具 |
| 框架 | **Next.js 15**（App Router） | 页面与 API 路由都放在 `src/app` |
| 渲染 | **Cesium** | 轨道可视化统一用 Cesium（`src/components/cesium/`）；从 `/cesium/Cesium.js` 单独加载，不进打包器；禁止引入第二套 3D/WebGL 封装 |
| UI | React 19 + 现有 CSS 变量体系 | 不引入 UI 框架，保持与官方界面截图一致 |
| 存储 | SQLite（better-sqlite3 + drizzle） | 单文件数据库，路径由 `SPACE_SAFETY_DB` 指定 |
| 计算端通信 | gRPC（`@grpc/grpc-js`） | 入口层与计算节点分离，包名 `spacesafety.worker.v1` |

**不允许**偏离上述技术选型。若确实需要，先改本文件并说明理由。

## 2. 面向对象开发模式（硬性）

本项目采用**面向对象设计**。判断标准不是「用了多少 class」，而是**职责是否有类型承载**：

1. **有状态的横切能力必须封装为类**，不接受散落的函数 + 模块级可变变量：
   - 外部服务客户端（Space-Track、星历下载、Starlink 摄入）→ 类，持有会话/重试/凭据
   - 计算内核（筛查、传播、剪枝）→ 类或不可变值对象，输入输出都是类型
   - 数据库访问、缓存、连接池 → 类
   - 命令行工具 → 一个 `Command` 类，`run(argv)` 返回退出码
2. **数据用值对象 / 接口表达**，不用裸对象字面量在模块间传递未命名结构。
3. **继承只用于真正的 `is-a`**；复用优先组合。现有 `extends Error` 的错误层次是正确用法。
4. **禁止**：单例可变全局状态（环境变量读取除外）、模块级 `let` 计数、跨文件的隐式初始化顺序依赖。
5. 纯数学函数（`linalg.ts`、`alfano.ts` 的公式）保持函数式**不违反本条**：
   它们无状态、无依赖，包装成对象反而降低可测性。规则只约束**有状态**的东西。

**仍未处理**：`src/worker/screening-thread.ts` 的模块级可变缓存
（`sharedTracks`、`sources`、`parsed`）与模块级 `let` 计数（`usedBytes`、
`cachedChars`）应收敛为一个 `ThreadScratch` 类。此前这里写着"见 CHANGELOG 0.1.4"，
而该条目并不存在 —— 记为已知欠账，不假装已排期。

## 3. 脚本与工具统一用 TypeScript

- `tools/*.py` **全部删除**，对应能力以 `tools/*.ts` 重写，通过 `package.json` 的
  `npm run` 脚本暴露；不再要求用户装 Python 虚拟环境。
- 前端、后端、脚本、测试共用同一套 `tsconfig` 与类型。
- 唯一允许的非 TS 是**文件形态的交付物**（文档、证书、`.gitignore`），不是可执行逻辑。

## 4. 多语言（硬性）

- 首期支持 6 种语言：`zh-CN`、`en`、`es`、`fr`、`de`、`ja`。
- 所有面向用户的文案必须来自字典，**禁止在 JSX/TSX 里写死中文或英文**。
- 新增文案必须同时补齐 6 个语种的键，缺失键由构建期检查报错（不是运行期回退）。
- 技术标识（`STARLINK-1234`、CCSDS 字段名、单位 `km/s`）不翻译。
- 时间与数字按 locale 格式化；轨道数据本身与语言无关。

## 5. 版本控制

### 5.1 版本号

- **每次迭代只递增补丁号**：`0.1.4` → `0.1.5` → …。不跳号、不并行多分支各改各的版本。
- 一次提交对应一个版本。**一个版本 = 一次提交 + 一个 tag + 一次推送**，三者缺一不算发布。

### 5.2 发布流程（照抄执行，顺序不能颠倒）

```bash
# 1) 改版本号（两处必须同时改，否则 check 会报 version 不一致）
#    package.json 的 "version" 与 package-lock.json 的 "version"（根对象与 packages[""] 各一处）
# 2) 在 CHANGELOG.md 顶部新增 "## [X.Y.Z] - YYYY-MM-DD" 条目
#    写清"为什么改"；影响计算结果/数据格式的改动必须写验证方式
# 3) 自检：类型 + 测试 + 规则
npx tsc --noEmit && npm test && npm run check

# 4) 提交（首行必须形如 vX.Y.Z: 一句话摘要）
git add -A
git commit -m "vX.Y.Z: 一句话摘要"   # 正文写动机与验证

# 5) 打 tag（名字必须带 v 前缀，且等于 package.json 的版本）
git tag vX.Y.Z

# 6) 推送：分支与 tag 都推
git push origin main
git push origin --tags

# 7) 回读确认（第 8 步会自动做，也可手工执行）
git ls-remote --tags origin | wc -l && git tag | wc -l
```

```
# 8) 发布校验：五项全过才算发布完成
npm run release:verify
```

### 5.3 「四处一致」的完整定义

| # | 位置 | 要求 | 谁来查 |
|---|---|---|---|
| 1 | `package.json` | `version` = X.Y.Z | `npm run check` |
| 2 | `package-lock.json` | 根对象与 `packages[""]` 的 `version` = X.Y.Z | `npm run check` |
| 3 | `CHANGELOG.md` | 首条 = `## [X.Y.Z]` | `npm run check` |
| 4 | git tag | 存在 `vX.Y.Z`，且指向 HEAD | `npm run check` + `npm run release:verify` |
| 5 | **远端** | `origin` 上有该提交与该 tag | `npm run release:verify` |
| 6 | **每条历史 tag** | `git show vX.Y.Z:package.json` 的 version 与 `git show vX.Y.Z:CHANGELOG.md` 的首条都等于 X.Y.Z | `npm run check` 逐条校验全部 tag |

前四条是**本地**一致，`npm run check` 能离线查；第 5 条必须联网，只有
`npm run release:verify` 能查。**本地一致 ≠ 已发布**：曾出现 17 个提交与 17 个 tag 全部只
在本地、`npm run check` 一路绿灯的情况——这就是第 5 条存在的原因。

### 5.4 三个必须知道的坑

1. **`git push --follow-tags` 带不走本仓库的 tag。** 它只推**附注 tag**；本仓库用的
   （除 v0.1.2 与 v0.1.5 外）是**轻量 tag**，会被静默略过。必须显式 `git push origin --tags`。
2. **不要用重建 tag 的方式做测试。** 删掉再建会改变 tag 的类型（附注 ↔ 轻量），指向同一提交
   也无法推送，且历史被改动。测试未推送状态请用一次性名字（如 `v0.0.0-negative-test`）并在
   测完立刻删除。
3. **tag 打在错误的提交上，本地检查查不出。** 所以 `npm run check` 逐条读取每个 tag 自己的
   `package.json` 与 `CHANGELOG.md`，而不是只比对 HEAD 与最新 tag。

### 5.5 记录要求

- `CHANGELOG.md` 每条写清**为什么改**，而不只是"改了什么"。
- 影响计算结果、剪枝策略或数据格式的改动，必须写明验证方式。
- 已知问题单列，不藏在"修复"里。
- 提交信息首行为 `vX.Y.Z: 一句话摘要`，正文说明动机与验证。

## 6. 仓库内容

- **禁止入库**：星历缓存、SQLite 数据库、任何模型/星历下载产物、凭据、证书私钥。
- `.gitignore` 规则**必须带锚点或限定目录**。历史上裸写 `core` 曾把 `src/lib/core/`
  整个计算内核忽略掉，仓库因此无法编译——这是本条规则的由来。
- 提交前必须跑一遍「本地源文件 vs `git ls-files`」比对，确认无遗漏。

## 9. 视觉规范（spacelibre VI）

视觉规范以 **<https://vi.spacelibre.cn>**（VI 手册 1.5.34）为准，矢量母版与令牌同步自
<https://github.com/spacelibres/vi>。本仓库只是消费者，不自行解释规范：

1. **颜色只有一个来源**：`src/lib/vi/palette.ts`。CSS、Cesium、SVG、图标
   一律从它读取。禁止在任何组件、样式表或场景代码里写十六进制色值——
   `npm run check` 会拦截。
2. **token 与资源由脚本生成**：`npm run vi` 生成 `src/app/vi-tokens.css` 与
   `public/vi/*.svg`。手改生成物会在下次生成时丢失。
3. **Logo 用真实矢量母版**（`design/vi-source/`，来自 VI 仓库），不得用文字或
   自绘圆环代替。单色母版（black / white / navy）保持单一墨色，任何主题变化都
   不得给它们加辅助色。全彩母版按主题重着色**星球**；蒙版的结构色 black / white
   永不参与主题化。

   **编排按用途选，不能拿上下编排硬塞进导航**（VI §编排）：

   | 用途 | 母版 | SVG 画布 | 最小显示宽度 |
   |---|---|---|---|
   | 网站导航、页脚、文档标题区 | horizontal | 810 × 180 | **≥ 240 px** |
   | 封面、启动页、品牌展示 | stacked | 620 × 430 | ≥ 180 px |
   | 头像、应用标识、紧凑空间 | icon | 256 × 256 | ≥ 48 px |

   **安全留白 = 画布高度的 25%**，四周各留出这么多。因此导航栏宽度不是审美选择：
   240 px 宽的水平母版高 53.3 px，留白 13.3 px，侧栏至少要 240 + 2 × 13.3 =
   **266.7 px** —— `--sidebar-w` 由 `tools/vi.ts` 按这个算式生成（当前 272 px）。
   低于最小尺寸时换编排（导航降到 icon 母版），不是把母版缩小。
4. **可读性优先**：正文对比度 ≥ 4.5:1，大字 ≥ 3:1。状态色（success / warning /
   danger）按白纸设计，在深色背景上须经 `legibleOn()` 提升到阈值，不得另造一套
   暗色专用色。语义色（风险等级、状态）不跟随装饰性强调色变化。
5. **切换必须覆盖整页**：导航、背景、卡片、图表、3D 画布、favicon、下载的 SVG
   都要跟随，不能只换面板。
6. **字体**：拉丁文 Arial / Arial Bold，中文用系统无衬线，技术元数据用等宽
   （Consolas）。Logo 是轮廓矢量，不是字体。
7. **轨道等装饰元素**：连续、置于内容之后、自然淡出；不得用不透明色块遮挡接缝。

## 7. 提交前必须通过的检查

```bash
npx tsc --noEmit            # 类型
npm test                    # 测试套件
node --conditions=react-server --import tsx tools/check.ts   # 规则自检
```

`tools/check.ts` 会校验：无 Python 残留、无硬编码文案、i18n 键齐全、
版本号四处一致（含**每个历史 tag 自带的版本**）、`.gitignore` 无危险规则、客户端 chunk 可解析、
VI 配色与标志一致。任一项失败即不得提交。

**发布后**还要跑一次（它联远端，所以不在提交前那三条里）：

```bash
npm run release:verify   # 工作区干净 / HEAD 已打 tag / 每条 tag 自带版本 / 无未推送提交 / 远端 tag 与本地一致
```

五项全过才叫"已发布"。只跑前三条会让版本留在本地——曾经 17 个版本就这样没上到 GitHub。
