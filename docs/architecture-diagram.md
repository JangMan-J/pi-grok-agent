# Architecture diagram

The stdio-direct prototype. Full walkthrough: [usage.md](usage.md#components).

```mermaid
flowchart LR
    PI["Pi extension<br/>transcript, gates, dialogs"]
    GK["Grok Build child<br/>--no-leader stdio<br/>native tools and agent"]
    PI <-->|"ACP over stdin/stdout<br/>and _x.ai/mcp/sdk_call"| GK
```

```text
Pi extension <-- ACP pipes, including lent-tool sdk_call --> Grok agent child (--no-leader stdio)
```

- Pi starts one non-detached child on the first turn, never a shared leader or daemon (`src/model/connection.ts`). The child uses `--permission-mode default` and disables its auto-updater.
- Lent tools use MCP-over-ACP on that pipe (`x.ai/mcp/sdk`, `x.ai/mcp/servers`, `_x.ai/mcp/sdk_call`).
- The guard sends one fail-closed answer per pending reverse request on orderly close and suppresses late answers (`src/model/guard.ts`). There are no ack timers. A hung-but-alive Pi is unguarded; Grok fails open on hook timeout.
- Fake-child verification: `test/transport.test.ts`. Live results: [design](first-class-model.md#direct-agent-and-mcp-over-acp).
