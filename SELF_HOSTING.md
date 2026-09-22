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

The public MCP endpoint runs in stateless JSON mode. Ordinary MCP traffic uses
POST requests only; GET/DELETE requests to `/mcp` return `405 Method Not
Allowed`. Use an MCP client/Inspector for a full protocol test.

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

A successful authorization form submission returns an HTTP `303 See Other`
redirect to ChatGPT's OAuth callback with `code`, `state`, and `iss` query
parameters. The authorization page CSP explicitly allows the configured OAuth
redirect origins (for ChatGPT, `https://chatgpt.com`) so Chromium browsers do not
block the cross-origin redirect after the form POST. Do not submit the same
authorization form again. If a duplicate submit occurs, the server reports
that the authorization was already completed instead of treating it as an
expired request.

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

Install and authenticate `cloudflared` once:

```bash
brew install cloudflared
cloudflared tunnel login
```

Create a named tunnel and DNS route once:

```bash
cloudflared tunnel create desktop-commander
cloudflared tunnel route dns desktop-commander mcp.example.com
```

Copy `deploy/cloudflare/config.example.yml` to
`~/.cloudflared/config.yml`, then replace the tunnel UUID, credentials path
and hostname. Validate it once:

```bash
cloudflared tunnel ingress validate
```

### Run MCP + Cloudflare in one terminal

The repository includes a supervisor that starts the local self-host MCP,
waits for `/health`, starts the named Cloudflare Tunnel, forwards both
processes to the same terminal, and shuts both down together with `Ctrl+C`.

If `~/.cloudflared/config.yml` contains the `tunnel:` field, no Cloudflare
environment variable is required. From a source checkout, one command builds
and starts everything:

```bash
export DC_AUTH_MODE=oauth
export DC_OAUTH_ISSUER="https://mcp.example.com"
export DC_OAUTH_ADMIN_PASSWORD='your-custom-password'

npm run self-host:cloudflare
```

For an already-built checkout, skip the build step:

```bash
npm run start:self-host:cloudflare
```

If the tunnel name or UUID is not present in the default Cloudflare config,
provide it explicitly:

```bash
export DC_CLOUDFLARE_TUNNEL="desktop-commander"
npm run self-host:cloudflare
```

If the Cloudflare config is stored somewhere else:

```bash
export DC_CLOUDFLARE_CONFIG="~/.cloudflared/desktop-commander.yml"
export DC_CLOUDFLARE_TUNNEL="desktop-commander"
npm run self-host:cloudflare
```

The launcher performs a `cloudflared --version` preflight before starting the
MCP server. If either the MCP server or `cloudflared` exits unexpectedly, the
launcher stops the other process too rather than leaving half of the stack
running.

Your public MCP URL is then:

```text
https://mcp.example.com/mcp
```

Keep the origin bound to localhost. Cloudflare Tunnel makes an outbound
connection to Cloudflare, so there is no reason to expose port 8765 on the LAN
or router.

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
| `DC_LOCAL_MCP_TOOL_TIMEOUT_MS` | `120000` | Base timeout for gateway → local Desktop Commander tool calls; process tools automatically extend this to at least their requested `timeout_ms` plus 30 seconds, capped at 30 minutes |
| `DC_CLOUDFLARED_BIN` | `cloudflared` | Path/name of the cloudflared executable used by the one-terminal launcher |
| `DC_CLOUDFLARE_CONFIG` | cloudflared default config lookup | Optional config path passed as `cloudflared tunnel --config <path> run`; `~/...` is expanded |
| `DC_CLOUDFLARE_TUNNEL` | value from Cloudflare config | Optional named tunnel or UUID appended to `cloudflared tunnel run` |
| `DC_SELF_HOST_STARTUP_TIMEOUT_MS` | `20000` | How long the launcher waits for the local `/health` endpoint before aborting startup |

Self-host mode forcibly sets these internally:

```text
DC_SELF_HOSTED=true
DESKTOP_COMMANDER_DISABLE_TELEMETRY=1
DESKTOP_COMMANDER_DISABLE_REMOTE_SERVICES=1
```

This prevents the local Desktop Commander child from contacting the upstream
telemetry and feature-flag services.

## MCP App UI resources

Desktop Commander tools such as `get_config` and `read_file` can advertise
MCP App UI metadata, including `openai/outputTemplate` /
`ui/resourceUri`. The self-host gateway preserves that metadata and proxies
the local Desktop Commander resource API so ChatGPT can actually load the
referenced templates.

The gateway advertises the `resources` capability and proxies:

```text
resources/list
resources/templates/list
resources/read
```

This includes the packaged UI resources:

```text
ui://desktop-commander/config-editor
ui://desktop-commander/file-preview
```

Without this proxy, tool execution can still succeed, but ChatGPT may show
`Failed to fetch template` while trying to render the MCP App card.

## Stateless HTTP transport and tool-call timeouts

The public MCP endpoint intentionally uses the MCP SDK 1.x stateless
Streamable HTTP pattern: every authenticated POST gets a fresh lightweight MCP
`Server` + `StreamableHTTPServerTransport`, with
`sessionIdGenerator: undefined` and `enableJsonResponse: true`.

The long-lived local Desktop Commander stdio child is still shared by all
requests, so terminal sessions/processes started by tools remain available to
later tool calls. Only the public HTTP protocol layer is stateless.

Consequences:

- no `Mcp-Session-Id` is issued or required;
- there is no in-memory HTTP session map, idle reaper, or LRU eviction;
- ordinary initialize/list/call requests return direct JSON responses;
- GET/DELETE on `/mcp` return `405` because this gateway does not expose
  server-initiated notifications, resumability, sampling, or elicitation;
- ChatGPT reconnects cannot accumulate hundreds of retained MCP sessions.

The local stdio MCP client has its own request timeout. The gateway uses a
120-second base timeout instead of the MCP SDK's 60-second fallback. For
`start_process`, `read_process_output`, and `interact_with_process`, the
gateway timeout is automatically extended to at least the tool's
`timeout_ms + 30000`, up to 30 minutes. This prevents the proxy layer from
timing out before the process tool's own timeout has elapsed.

The health endpoint reports the transport mode and number of HTTP MCP requests
currently in flight:

```bash
curl http://127.0.0.1:8765/health
```

Relevant fields include `transportMode: "stateless-json"` and
`activeMcpRequests`.

## Development

Run directly from TypeScript:

```bash
DC_MCP_TOKEN="$(openssl rand -hex 32)" npm run dev:self-host
```

Run the focused self-host security, OAuth, Cloudflare-launcher, and
stateless-transport integration tests:

```bash
npm run test:self-host
```

The OAuth integration test performs a complete local DCR → authorization →
PKCE token exchange → refresh-token rotation flow without contacting ChatGPT.
The stateless transport integration test launches the real self-host server,
verifies that initialize and `tools/list` work as independent POST requests
without an `Mcp-Session-Id`, confirms JSON responses, verifies the
`get_config` output-template URI is present in `resources/list`, reads the
packaged MCP App HTML through `resources/read`, checks
`resources/templates/list`, and verifies GET `/mcp` is rejected with
`405`.

The normal stdio entrypoint remains unchanged, so upstream/local clients can
still use:

```bash
npm start
```
