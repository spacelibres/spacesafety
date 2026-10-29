# 申请 Starlink Space Safety API 接入（分步操作指南）

> 本文件说明如何完成 mTLS 凭证申请。**这一步必须以 Space Eyes 组织授权人的身份完成**，
> 无法由工具或第三方代办：SpaceX 要求申请人签署服务条款，并认证其有权代表组织签署。

## 为什么必须由你来做

官方原文（`docs/starlink-space-safety/quick-start.md`）：

> After contacting space-safety-onboarding@spacex.com, you will receive an email
> instructing you to set up a passkey for access to staging.space-safety.starlink.com.
> The first person who logs in must sign our Terms of Service to get access to this system.
> Part of agreeing to those terms is certifying that you are authorized to sign that
> agreement on behalf of your organization.

以及（`docs/starlink-space-safety/api-keys.md`）：

> `space-safety.starlink.com` uses mTLS for client authentication.

API **仅对卫星运营方开放**。如果你是运营方（拥有或即将拥有在轨航天器），按下述流程办理。

## 第 1 步：生成密钥对与 CSR（已完成）

已在本仓库 `certs/` 下生成：

| 文件 | 说明 | 处理方式 |
|---|---|---|
| `certs/client.key` | 你的 EC P-384 私钥 | **绝不外泄**，权限已设为 600 |
| `certs/client.csr` | 证书签名请求 | **发送给 SpaceX** |
| `certs/identity.json` | 证书主体信息 | 供后续复现使用 |

等效命令（如需重新生成，`CN` 换成唯一标识你组织的值）：

```bash
openssl req -new -newkey ec:<(openssl ecparam -name secp384r1) -nodes \
  -keyout client.key -sha384 -out client.csr \
  -subj "/CN=spaceeyes/O=Space Eyes/OU=Operations"
```

> 如需修改组织名，编辑 `certs/identity.json` 后重新执行上面的命令。

## 第 2 步：发送申请邮件

**收件人**：`space-safety-onboarding@spacex.com`
**主题**：`Space Safety Platform onboarding request — Space Eyes`

正文模板（请补全 `<>` 内信息后发送）：

```
Hello SpaceX Space Safety team,

We would like to request onboarding to the Starlink Space Safety Platform
for the following organization.

Organization:      Space Eyes
Country:           <国家/地区>
Website:           <官网 URL>
Primary contact:   <姓名>, <职务>
Email:             <工作邮箱>
Phone:             <联系电话，用于交会协调>

Operated / planned spacecraft:
  - <卫星名> (NORAD ID: <如有>), <轨道高度>, <是否具备机动能力>, <硬体半径 m>

Intended use:
  - Publish operator ephemerides (CCSDS OEM) for conjunction screening
  - Consume CDMs and conjunction events via the REST API for our
    orbital-visualization and risk dashboard product

Requested environment: staging first, production after validation.

Our CSR for client-certificate signing is attached (EC P-384 / SHA-384,
CN=spaceeyes, O=Space Eyes, OU=Operations).

Please also send the passkey setup instructions for the web UI.

Best regards,
<姓名>
<职务>, Space Eyes
```

**附件**：`certs/client.csr`

## 第 3 步：接收并保存证书

SpaceX 回信会包含 `client.crt`。放到：

```
certs/client.crt
```

另外他们会发 passkey 设置邮件，用于登录 staging 的 Web UI
（`https://staging.space-safety.starlink.com`）。首次登录者需签署服务条款。

## 第 4 步：验证连通性

证书就位后执行：

```bash
npm run verify:mtls
```

该脚本会：
1. 校验 `client.crt` 与 `client.key` 是否配对、证书是否过期
2. 用 mTLS 请求 `GET /api/v1/operator` 验证身份已被系统接受
3. 报告响应耗时与错误诊断

预期看到你组织的 operator 信息。若返回 `403`，说明证书尚未被 SpaceX 签名/加载；
若 `503`，是限流，稍后重试。

## 第 5 步：切换应用数据源

`.env.local` 中：

```bash
SPACE_SAFETY_ENV=staging
SPACE_SAFETY_MTLS_CERT=./certs/client.crt
SPACE_SAFETY_MTLS_KEY=./certs/client.key
SPACE_SAFETY_SOURCE=live        # mock -> live
```

重启应用即从 Mock 切换到真实 API，前端无需改动。

## 注意事项

- **不要在 staging 提交 `definitive` 轨迹后忽略它**：staging 与 production 完全隔离，
  但错误配置指向 production 会让你的轨迹被其他运营方用于真实碰撞评估。
- **私钥轮换**：`client.key` 泄露需立即生成新密钥对并重新提交 CSR。
- **限流**：超限返回 `503`，按运营方维度计数。轮询间隔建议 ≥ 60 秒
  （见 `docs/starlink-space-safety/api-patterns.md` 的官方示例）。
