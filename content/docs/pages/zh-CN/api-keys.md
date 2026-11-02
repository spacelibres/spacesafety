# API 密钥与身份

## 身份就是证书

本部署用**双向 TLS** 认证。没有 API-key 头、没有换取 token 的端点，也没有可嵌进
客户端的密钥：客户端出示证书，证书里的身份就是调用方。

这带来几个必须说清楚的后果：

- 换密钥 = 签发新证书，不是改一个请求头。
- 密钥泄露就是私钥泄露，`client.key` 要按 SSH 私钥的规格保管。
- 没有"登录"这一步。第一个请求要么已认证，要么失败。

## 你会看到的失败

```http
HTTP/1.1 401 Unauthorized
content-type: application/json

{
  "correlation_id": "8f2fddc5-004a-42a7-b8ee-6e65e9ba7ac8",
  "error": "RBAC: access denied",
  "error_type": "unauthorized",
  "metadata": {}
}
```

同一个请求在服务端日志里有相同的 `correlation_id`：这是把客户端可见的失败和
服务端记录对上的唯一凭据，报问题请带上它。

## 申请证书

没有自助端点。证书线下签发，因为"签发"本身就是授予访问权的动作。

```bash
# 运营方提交 CSR，私钥不外发。
openssl req -new -newkey rsa:2048 -nodes \
  -keyout client.key -out client.csr -subj "/CN=<运营方名称>"

# 拿到证书后这样调用：
curl --key client.key --cert client.crt https://<host>/api/v1/operator
```

## 证书不授予的东西

证书只负责"你是谁"，不越过它映射到的运营方。两种不同后果：

| 尝试 | 结果 |
|---|---|
| 通过 `/v1/trajectory` 读别的运营方的星历 | 被过滤掉——该流只含调用方自己的数据 |
| 通过 `/v2/cdm` 读不属于你的 CDM | `400`——必须给出指名你的过滤条件 |

## 本页范围

上游服务里密钥还会出现在账号的用户列表中。这里根本没有用户表：见**用户**页面，
它列出的是已签发的证书，而不是虚构一批并不存在的账号。
