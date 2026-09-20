# Self-hosted Remote MCP

This fork can expose Desktop Commander directly from your own machine using
MCP Streamable HTTP. It does **not** use `mcp.desktopcommander.app`, Supabase
Realtime, Desktop Commander telemetry, or the hosted feature-flag service.

The recommended topology is:

```text
ChatGPT / MCP client
        |
        | HTTPS
        v
Cloudflare Tunnel
        |
        v
127.0.0.1:8765/mcp
        |
        v
Desktop Commander local stdio child
```

## Security model

Desktop Commander can execute shell commands and read/write files with the
permissions of the account running it. Treat this endpoint like remote shell
access.

The self-hosted server therefore:

- binds to `127.0.0.1` by default;
- supports static Bearer auth, OAuth 2.1 + PKCE, or both;
- requires authentication on every `/mcp` request;
- refuses non-loopback binds unless explicitly overridden;
- forces Desktop Commander telemetry off;
- disables vendor-hosted remote feature flags;
- does not run the vendor Remote Device/Supabase relay.

For stronger isolation, run the process in a VM/container or under a dedicated
OS user with access only to the directories you want the AI to control.

## Build

```bash
git clone https://github.com/vietdungdev0106/DesktopCommanderMCP.git
cd DesktopCommanderMCP
npm install
npm run build
```

This fork's `postinstall` does not run the upstream installation tracking
script.

## Start locally

Generate a 256-bit token:

```bash
export DC_MCP_TOKEN="$(openssl rand -hex 32)"
```

Start the server:

```bash
npm run start:self-host
```

Defaults:

```text
MCP:    http://127.0.0.1:8765/mcp
Health: http://127.0.0.1:8765/health
```

Optional local settings:

```bash
export DC_MCP_PORT=8765
export DC_MCP_HOST=127.0.0.1
```

A non-loopback bind is intentionally rejected. It can be overridden with
`DC_MCP_ALLOW_NON_LOOPBACK=true`, but this is unnecessary for Cloudflare
Tunnel and is not recommended.

Check health:

```bash
curl http://127.0.0.1:8765/health
```

The MCP endpoint requires auth:

```bash
curl -i \
  -H "Authorization: Bearer $DC_MCP_TOKEN" \
  http://127.0.0.1:8765/mcp
```

A GET without an MCP session is expected to return an MCP error. Use an MCP
client/Inspector for a full protocol test.

## ChatGPT Web: OAuth 2.1 + PKCE

For ChatGPT Web, use OAuth mode instead of sharing a static MCP bearer token.
The server implements the MCP authorization discovery contract, Authorization
Code flow with PKCE S256, RFC 9207 issuer identification, CIMD, DCR, access
tokens, and rotating refresh tokens.

Your Cloudflare hostname must already point at the local server before starting
the ChatGPT connection.

Set these variables:

```bash
export DC_AUTH_MODE=oauth
export DC_OAUTH_ISSUER="https://mcp.example.com"
export DC_OAUTH_ADMIN_PASSWORD='your-custom-password'

npm run start:self-host
```

In OAuth mode, `DC_MCP_TOKEN` is not required.

The public endpoints are:

```text
https://mcp.example.com/mcp
https://mcp.example.com/.well-known/oauth-protected-resource
https://mcp.example.com/.well-known/oauth-authorization-server
https://mcp.example.com/authorize
https://mcp.example.com/token
https://mcp.example.com/register
```

The protected-resource document advertises the exact canonical OAuth resource,
and the authorization server metadata advertises:

- Authorization Code and refresh-token grants
- PKCE `S256`
- token endpoint auth method `none` for public clients
- Client ID Metadata Documents (CIMD)
- Dynamic Client Registration (DCR)
- RFC 9207 `iss` authorization-response identification

By default, CIMD client IDs are accepted only from `chatgpt.com`, and redirect
URIs are accepted only on the `https://chatgpt.com` origin. This makes the
default OAuth configuration intentionally ChatGPT-specific rather than a
general-purpose public authorization server.

### Connect from ChatGPT

Use this MCP endpoint when creating the custom app/server:

```text
https://mcp.example.com/mcp
```

Choose OAuth authentication if the UI asks for the authentication mechanism.
ChatGPT discovers the OAuth endpoints automatically from the well-known
metadata.

During the first connection, the browser opens the self-hosted authorization
page. Enter the value of `DC_OAUTH_ADMIN_PASSWORD`. This is a password for
your Desktop Commander authorization server; it is **not** your ChatGPT
password.

After approval, ChatGPT exchanges the authorization code using PKCE and stores
the resulting connection tokens. Access tokens default to one hour. Refresh
tokens default to 30 days and rotate on every successful refresh.

A successful authorization form submission is expected to return an HTTP
redirect (normally `302`) to ChatGPT's OAuth callback with `code`, `state`, and
`iss` query parameters. Do not submit the same authorization form again. If a
duplicate submit occurs, the server reports that the authorization was already
completed instead of treating it as an expired request.

For OAuth troubleshooting, the self-host server logs high-level trace lines
without printing raw authorization codes, request IDs, passwords, access
tokens, or refresh tokens. Useful messages include:

```text
[self-host][oauth] Authorization approved ...
[self-host][oauth] Token exchange received ...
[self-host][oauth] Token exchange succeeded ...
[self-host][oauth] Token exchange rejected ... reason=...
```

If authorization succeeds but no "Token exchange received" line appears, the
failure is between the browser callback and ChatGPT rather than in the local
token endpoint.

### OAuth state persistence

OAuth registrations and token hashes are persisted by default at:

```text
~/.claude-server-commander/self-host-oauth.json
```

Raw access tokens, raw refresh tokens, raw authorization request IDs, raw
authorization codes, and `DC_OAUTH_ADMIN_PASSWORD` are not written to that
file. The file is created with owner-only permissions.

Short-lived authorization request state and authorization-code state are
persisted using SHA-256 hashes for their bearer identifiers. This allows an
OAuth browser flow to continue after the self-host server restarts, provided
the original request/code has not reached its normal expiry time. Pending
authorization requests expire after 10 minutes and authorization codes expire
after 5 minutes. Expired transient state is removed during initialization and
normal OAuth activity.

### Hybrid migration mode

If you still have a client using the old static token while moving ChatGPT to
OAuth:

```bash
export DC_AUTH_MODE=both
export DC_MCP_TOKEN="$(openssl rand -hex 32)"
export DC_OAUTH_ISSUER="https://mcp.example.com"
export DC_OAUTH_ADMIN_PASSWORD='your-custom-password'

npm run start:self-host
```

In `both` mode, `/mcp` accepts either the static `DC_MCP_TOKEN` or a valid
OAuth access token. OAuth discovery is still published for ChatGPT.

## Cloudflare Tunnel

Install cloudflared on macOS:

```bash
brew install cloudflared
cloudflared tunnel login
```

Create a named tunnel:

```bash
cloudflared tunnel create desktop-commander
cloudflared tunnel route dns desktop-commander mcp.example.com
```

Copy `deploy/cloudflare/config.example.yml` to
`~/.cloudflared/config.yml`, replace the tunnel UUID, credentials path and
hostname, then validate and run:

```bash
cloudflared tunnel ingress validate
cloudflared tunnel run desktop-commander
```

Your public MCP URL is then:

```text
https://mcp.example.com/mcp
```

Configure the MCP client to send:

```text
Authorization: Bearer <DC_MCP_TOKEN>
```

Keep the origin bound to localhost. The tunnel makes an outbound connection to
Cloudflare, so there is no reason to expose port 8765 on the LAN or router.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DC_AUTH_MODE` | `bearer` | `bearer`, `oauth`, or `both` |
| `DC_MCP_TOKEN` | required in bearer/both | Static Bearer token, minimum 32 bytes |
| `DC_OAUTH_ISSUER` | required in oauth/both | Public HTTPS origin, e.g. `https://mcp.example.com` |
| `DC_OAUTH_RESOURCE` | OAuth issuer | Canonical protected-resource HTTPS origin |
| `DC_OAUTH_ADMIN_PASSWORD` | required in oauth/both | Password used on the self-hosted authorization page; any non-empty value is accepted. Use a strong password. |
| `DC_OAUTH_ALLOWED_CIMD_HOSTS` | `chatgpt.com` | Comma-separated CIMD client host allow-list |
| `DC_OAUTH_ALLOWED_REDIRECT_ORIGINS` | `https://chatgpt.com` | Comma-separated OAuth redirect origin allow-list |
| `DC_OAUTH_STORE_PATH` | `~/.claude-server-commander/self-host-oauth.json` | Persistent client/token-hash store |
| `DC_OAUTH_ACCESS_TTL_SECONDS` | `3600` | Access-token lifetime |
| `DC_OAUTH_REFRESH_TTL_SECONDS` | `2592000` | Refresh-token lifetime |
| `DC_MCP_HOST` | `127.0.0.1` | Local listen host |
| `DC_MCP_PORT` | `8765` | Local listen port |
| `DC_MCP_ALLOW_NON_LOOPBACK` | false | Explicitly permit a non-loopback bind |

Self-host mode forcibly sets these internally:

```text
DC_SELF_HOSTED=true
DESKTOP_COMMANDER_DISABLE_TELEMETRY=1
DESKTOP_COMMANDER_DISABLE_REMOTE_SERVICES=1
```

This prevents the local Desktop Commander child from contacting the upstream
telemetry and feature-flag services.

## Development

Run directly from TypeScript:

```bash
DC_MCP_TOKEN="$(openssl rand -hex 32)" npm run dev:self-host
```

Run the focused self-host security and OAuth integration tests:

```bash
npm run test:self-host
```

The OAuth integration test performs a complete local DCR → authorization →
PKCE token exchange → refresh-token rotation flow without contacting ChatGPT.

The normal stdio entrypoint remains unchanged, so upstream/local clients can
still use:

```bash
npm start
```
