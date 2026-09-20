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
- requires a Bearer token on every `/mcp` request;
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
| `DC_MCP_TOKEN` | required | Bearer token, minimum 32 bytes |
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

Run the focused self-host security tests:

```bash
npm run test:self-host
```

The normal stdio entrypoint remains unchanged, so upstream/local clients can
still use:

```bash
npm start
```
