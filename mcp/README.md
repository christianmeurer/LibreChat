# Custom MCP Servers (stdio)

These servers are intended to run **inside the LibreChat Docker container**.

## Exec server

Runs a restricted set of commands with strict guardrails.

Run:

```bash
node /workspace/mcp/exec-server/index.mjs
```

## Fetch server

HTTP(S) GET-only fetch with SSRF protections and size/timeout caps.

Run:

```bash
node /workspace/mcp/fetch-server/index.mjs
```

## Self-check (in-container)

```bash
node /workspace/mcp/self-check/run-all.mjs
```

