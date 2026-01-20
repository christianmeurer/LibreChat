# MCP “Roo Code-like” setup for LibreChat

This workspace is configured so LibreChat can use **MCP (Model Context Protocol)** servers, which enables a Roo Code-like experience (tools that can read files, run commands, etc.) inside the LibreChat web UI.

## 1) Open LibreChat

- Visit: `http://localhost:3080`

### LAN access (recommended)

To access from another device on the same network, open:

- `http://192.168.15.83:3080`

This is the host’s LAN IP detected from `ipconfig`.
The Docker port is bound specifically to that LAN interface via `BIND_IP` in [`.env`](.env:1) and the mapping in [`docker-compose.yml`](docker-compose.yml:1) for safer LAN-only exposure.

If it doesn’t load:

- Ensure Windows Firewall allows inbound TCP `3080` on **Private** networks.
- If your LAN IP changes (DHCP), update the IP in [`docker-compose.override.yml`](docker-compose.override.yml:1) and restart the stack.
- If your LAN IP changes (DHCP), update `BIND_IP` in [`.env`](.env:1) and restart the stack.

## 1b) Remote access (VPN-only, safest) via Tailscale (free plan)

This option keeps LibreChat **off the public internet**.

### Steps (Windows host)

1. Install Tailscale on the host machine
   - https://tailscale.com/download
2. Log in and ensure it’s connected.
3. Find the host’s Tailscale IP (it will look like `100.x.y.z`).

### Fixing “no internet” after enabling Tailscale (DNS)

If IP connectivity works (you can ping `1.1.1.1`) but DNS lookups fail (`nslookup example.com` times out),
your tailnet DNS is likely pointing at an unreachable nameserver.

Since you have Tailscale **Admin Console** access, do this (recommended):

1. Open the DNS admin page:
   - https://login.tailscale.com/admin/dns
2. Under **Nameservers**:
   - Remove any IPv6 link-local nameservers like `fe80::...` (these commonly time out)
   - Add working public DNS resolvers (Cloudflare):
     - `1.1.1.1`
     - `1.0.0.1`
   - Keep **Override local DNS** enabled
3. Under **MagicDNS**:
   - You can leave MagicDNS ON or OFF; it’s not required for basic DNS,
     but ON is convenient for tailnet hostnames.
4. Apply/save.

Then on the Windows host, reconnect Tailscale (or toggle it off/on) and test:

```text
nslookup example.com
```

If DNS is still broken after changing the admin DNS settings:

- Run (on the Windows host):

```text
"C:\Program Files\Tailscale\tailscale.exe" down
"C:\Program Files\Tailscale\tailscale.exe" up
ipconfig /flushdns
nslookup example.com
```

### Bind LibreChat to Tailscale only

Set `BIND_IP` in [`.env`](.env:1) to the host’s Tailscale IP, e.g.:

```text
BIND_IP=100.64.0.10
```

Then restart:

```text
docker compose up -d --force-recreate api
```

Now access from any device logged into the same Tailscale tailnet:

- `http://<tailscale-ip>:3080`

### Why this is the safest “remote” option

- No router port-forwarding
- No public exposure of LibreChat + MCP filesystem tools
- Works even behind CGNAT

If you see the login screen, create the first user via **Sign up** (registration is enabled in [`.env`](.env:1)).

## 2) Set your model provider (OpenRouter)

- Put your OpenRouter key in [`.env`](.env:1) as:
  - `OPENROUTER_KEY=...`

LibreChat reads the OpenRouter endpoint from [`librechat.yaml`](librechat.yaml:1).

## 3) MCP is enabled (UI permissions)

In [`librechat.yaml`](librechat.yaml:1) we enabled MCP permissions:

- `interface.mcpServers.use: true`
- `interface.mcpServers.create: true`

This allows users to *use* and *create/manage* MCP servers from the UI.

## 4) Preconfigured MCP server: Filesystem

We preconfigured a stdio MCP server named `filesystem` in [`librechat.yaml`](librechat.yaml:1):

- Command: `npx -y @modelcontextprotocol/server-filesystem /workspace`
- Root exposed to the model: `/workspace`

The host project directory is bind-mounted into the container at `/workspace` via [`docker-compose.override.yml`](docker-compose.override.yml:1).

### Where to find it in the UI

After signing in:

- Go to **Settings → MCP Servers**
- You should see the configured server named **filesystem**

If it’s present but disconnected, try connecting it; LibreChat will launch it on-demand.

### Important: there is no built-in “file browser” here

The **MCP Settings** panel is for *configuring/connecting* MCP servers.
It typically **does not** render a directory tree UI.

Instead, the filesystem server exposes **tools** to the model (e.g. `list_directory`, `read_file`, `search_files`).
To validate it’s working:

1. Create/select an Agent (**My Agents**)
2. Add MCP tools for the `filesystem` server
3. Ask the agent something like:
   - “Use MCP filesystem `list_directory` on `/workspace` and show me the top-level files.”

## 5) Security notes (important)

- **Stdio MCP servers run inside the LibreChat container**, with the same permissions as the container user.
- The filesystem MCP server can read/write everything under `/workspace` (your host repo), so treat it like giving the model direct repository access.
- Only add MCP servers you trust.

## 6) RAG is intentionally disabled for now

RAG was disabled to avoid the `rag_api` crash-loop when no embeddings provider API key is set.

- We override `RAG_API_URL` to blank in [`docker-compose.override.yml`](docker-compose.override.yml:1)
- File uploads that require RAG/embedding may warn or be limited until you configure embeddings.

