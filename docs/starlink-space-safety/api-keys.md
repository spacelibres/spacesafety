<!-- source: https://space-safety.starlink.com/docs/api-keys -->

# API Keys

`space-safety.starlink.com` uses [mTLS](https://www.cloudflare.com/learning/access-management/what-is-mutual-tls/) for client authentication.

## Certificate Generation ​

In your initial onboarding email from SpaceX, you were instructed to generate a secret key and a certificate signing request (CSR) with a command like (with `CN`, `O`, `OU` set to values that identify your organization):

- Linux
- Windows

```
$ openssl req -new -newkey ec:<(openssl ecparam -name secp384r1) -nodes -keyout client.key -sha384 -out client.csr -subj "/CN=funspacecorp/O=Fun Space Corp/OU=Operations"
```

```
> openssl ecparam -name secp384r1 -out secp384r1.pem> openssl req -new -newkey ec:secp384r1.pem -nodes -keyout client.key -sha384 -out client.csr -subj "/CN=funspacecorp/O=Fun Space Corp/OU=Operations"
```

This command generates:

- client.key : Your secret key. Don't share this with anyone, and consult your internal security/IT team if you have questions about handling private key material.
- client.csr : Your CSR. Send to SpaceX so we can sign it for either our production or staging environments.

The `CN`, or "Common Name", should uniquely identify this credential. The `O` and `OU` fields are metadata, and are informational only.

After sending the CSR to SpaceX, you will receive a `client.crt` file.

## Rate Limiting ​

APIs may return HTTP 503 responses if they exceed API rate limits.

Our goal is that our rate limits provide no practical impediment to operators using the screening system. Please contact SpaceX if rate limiting is hampering your operations.
