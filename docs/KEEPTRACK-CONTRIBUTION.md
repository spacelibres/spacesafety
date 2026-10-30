# KeepTrack 作为第四源：必要性与代价

实测时间：2026-10-30　｜　工具：`npx tsx tools/keeptrack-contribution.ts`

---

## 一、结论

**KeepTrack 应该保留，但只为一个字段：`diameter_m`（直径）。**

它单独贡献了 **17,379 个在轨对象的直径（49.01%）** —— 其他所有源加起来只有 4,367 个。
其余 23 个字段上，KeepTrack 的贡献可以忽略或完全为零。

---

## 二、逐字段实测（在轨 35,460 个对象）

| 字段 | 主源已有 | KeepTrack 独有 | KeepTrack 补充 | 判定 |
|---|---|---|---|---|
| **diameter_m** | 4,367 | **17,379** | 4,029 | **★ 独有 49.01%** |
| shape | 22,629 | 218 | 21,226 | 独有 0.61% |
| mass_kg | 22,749 | 118 | 21,315 | 独有 0.33% |
| dry_mass_kg | 22,089 | 122 | 21,310 | 独有 0.34% |
| span_m | 22,749 | 115 | 21,328 | 独有 0.32% |
| length_m | 22,047 | 60 | 21,269 | 独有 0.17% |
| manufacturer | 24,828 | 8 | 24,022 | 仅交叉验证 |
| bus | 22,016 | 7 | 21,067 | 仅交叉验证 |
| name | 35,460 | 0 | 33,313 | 仅交叉验证 |
| country | 35,458 | 0 | 33,312 | 仅交叉验证 |
| launch_date | 35,458 | 0 | 33,312 | 仅交叉验证 |
| **cospar_id / object_class / launch_site / decay_date / inclination / period / apogee / perigee / rcs_size / hard_body_radius / cross_section / ballistic_coefficient / orbit_type** | — | **0** | 0 或部分 | **完全无贡献** |

---

## 三、该怎么用

### 3.1 只采纳一个字段

```
直径 diameter_m  → 主源无值时用 KeepTrack（17,379 个对象因此得到直径）
其余字段        → 只作交叉验证列，不作默认来源
```

### 3.2 不建议全量并列四源的原因

1. **131 列中 96 列是空的**（24 个字段 × 4 源的组合里，KeepTrack 只填 6 个字段）
2. 界面已出现列挤压，再加宽度只会更难读
3. 读者面对 4 个相同的值（如名称三源一致）并不会获得额外信息

### 3.3 但不要删掉 KeepTrack

- **直径**是唯一的实质增益，且对碰撞截面计算有用
- **交叉验证**：33,313 个对象三源名称一致，本身就是一个有价值的质量指标
- 保留整表成本很低（34,110 行，约 40 MB）

---

## 四、实施建议

宽表保留 `__keeptrack` 列不变（数据已存，删了要重抓），但调整**默认选择**：

| 字段 | 当前默认 | 建议默认 |
|---|---|---|
| `diameter_m` | spacebook | **keeptrack**（spacebook 仅 12%，keeptrack 59%） |
| 其余字段 | 保持不变 | 保持不变 |

---

## 五、Spacebook 自动登录（已解决）

之前文档写「需人工浏览器授权」。**实测可以完全自动化**，`npm run spacebook:auto`。

### 为什么不能用密码换 token

Auth0 租户 `comspoc-spacebook.us.auth0.com` 对该客户端只允许一种授权：

| 方式 | 实测结果 |
|---|---|
| `authorization_code` | ✅ 唯一允许 |
| `password` | ❌ 403 `Grant type 'password' not allowed for the client` |
| `password-realm`（ROPG） | ❌ 403 同上 |
| `device_code` | ❌ 403 同上 |
| `client_credentials` | ❌ 401（公开客户端，无密钥） |

### 自动化怎么做

用 `puppeteer-core` 驱动本机 Chrome 走真实登录页：

```
1. 打开 authorize URL（带 PKCE）
2. 第一步页：填邮箱 → 点 Continue
3. 第二步页：填密码 → 点 Continue
4. 捕获重定向到 https://www.spacebook.com/?code=...
5. 用 code + verifier 换 token，缓存到 data/.spacebook-token.json
```

**关键点**：登录是**两步式**（先邮箱后密码），不是单页表单。
第一版脚本在邮箱页等待密码框，30 秒后超时并误报「遇到验证码」——实际是选择器用错了。

### 仍然存在的限制

```
scope: openid profile email
refreshToken: 无
```

请求带了 `offline_access`，Auth0 仍不返回 refresh token。token 24 小时有效，
**每次同步都是重新登录**，不是续期。可以定时跑脚本解决，但每次会真实登录一次。

如遇到验证码或二次验证，脚本会失败并提示人工介入——此时没有绕过手段。
