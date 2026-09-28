# Native Grok permissions: read-only source review

## Result

`fs=false` does not auto-approve native writes in the inspected source. It selects `LocalFs` instead of client-provided ACP filesystem operations.

The observed global Claude setting explains the missing prompt through a separate permission-rule path:

```text
~/.claude/settings.json
  permissions.defaultMode = "bypassPermissions"
    -> synthetic Allow / Any rule
    -> permission manager returns Decision::Allow
    -> no AcpPrompter call
    -> no session/request_permission
```

`_meta.yoloMode:false` disables the session's YOLO switch. It does not remove that synthetic allow rule. Likewise, `--permission-mode default` overrides the launch YOLO default, but does not override Claude's `permissions.defaultMode` in this resolver.

This is a source-supported explanation with matching installed-binary configuration evidence. The original inference failure remains unverified here. No inference, WebSocket connection, global configuration change, or Grok patch occurred.

## Evidence and version boundary

- Checkout: `/tmp/pi-grok-ws-source`.
- Source commit: `f0e3be1100ef5252488e3be8bb0e91cf68d8c305`.
- Installed executable: `grok 1.0.41 (4220f3b224a6) [stable]`.
- These commit identifiers differ. Source/binary equivalence is not established.
- Prior protocol review: `/tmp/pi-grok-acp-review/websocket-protocol.md`.
- Current Grok configuration: `~/.grok/config.toml:18` contains `permission_mode = "always-approve"`.
- Current Claude configuration: `~/.claude/settings.json:6` contains `"defaultMode": "bypassPermissions"`.

Read-only installed-binary probe:

```sh
cd /tmp/grok-ws-probe-WoWnnE
grok inspect --json | jq '{cwd,permissions}'
```

Relevant output:

```json
{
  "cwd": "/tmp/grok-ws-probe-WoWnnE",
  "permissions": {
    "sources": ["/home/jangpi/.claude/settings.json (settings)"],
    "loaded": 1,
    "skipped": [],
    "managedSettingsExists": false,
    "managedSettingsActive": false
  }
}
```

The output confirms that the installed binary loads one permission rule from the global Claude file in this synthetic workspace. It does not report the rule's action. The inspected resolver supplies that interpretation. This probe does not establish the configuration of every workspace used by the separate Pi RPC test.

`cbm call list_projects` with `CBMP_PROFILE=scout` did not list this checkout. This review used direct source reads rather than an incomplete graph. No index build was necessary.

## Exact call path

All paths in this section are relative to `crates/codegen/` at commit `f0e3be1100ef5252488e3be8bb0e91cf68d8c305`.

### 1. Launch mode and session mode are separate from permission rules

`xai-grok-pager-bin/src/main.rs:1316–1330` calls `effective_yolo_for_launch` and `effective_auto_for_launch`, then sets the agent defaults.

`xai-grok-shell/src/util/config/permissions.rs:169–252` implements the precedence. An explicit CLI mode wins over `[ui] permission_mode`. Only `bypassPermissions` and `always-approve` select YOLO through this CLI-mode branch. Therefore, the supplied `--permission-mode default` suppresses the global UI always-approve default in this source.

`xai-grok-shell/src/agent/mvp_agent/session_setup.rs:450–460` reads `_meta.yoloMode` with `as_bool()`. An explicit `false` wins over `self.default_yolo_mode`. The adjacent code resolves `_meta.autoMode` separately.

### 2. Filesystem capabilities select a backend

`xai-grok-shell/src/agent/mvp_agent/agent_ops.rs:4160–4225` computes:

```rust
let use_acp_fs = client_fs_read && client_fs_write;
```

The true branch creates `AcpSessionFs`. The false branch creates `LocalFs`. `client_terminal` separately selects `AcpTerminalRunner` or `TerminalRunner`.

Neither selection creates an allow-all permission handle. In `xai-grok-shell/src/session/acp_session_impl/spawn.rs:362–479`, ordinary sessions construct the permission manager independently of filesystem capability flags. The legacy `support_permission` value is explicitly unused at line 362.

### 3. Session creation loads native and Claude rules

`xai-grok-shell/src/session/acp_session_impl/spawn.rs:374–429`:

1. Resolves folder trust.
2. Calls `resolve_permission_config_with_fallback_pinned`.
3. Merges CLI permission rules.
4. Applies the startup permission hint.

Lines 458–479 create `spawn_permission_manager_with_pin` with both the resolved rules and `session_yolo_mode`. These are separate inputs.

`xai-grok-workspace/src/permission/resolution.rs:490–588` loads native rules and the Claude compatibility configuration. A completed Claude-import marker can disable the Claude fallback. The live `inspect` output confirms that the fallback applies in the probed workspace.

`resolution.rs:594–641` selects the most-specific Claude `defaultMode`. Global Claude settings still load for untrusted folders. Project settings require folder trust.

`resolution.rs:28–68` implements `synthetic_rules_for_default_mode`. For `bypassPermissions`, absent a policy pin, it appends:

```rust
PermissionRule {
    action: RuleAction::Allow,
    tool: ToolFilter::Any,
    pattern: None,
    pattern_mode: PatternMode::Glob,
}
```

### 4. Native writes pass through the permission manager

`xai-grok-workspace/src/permission/types.rs:297–303` maps `SearchReplace`, `HashlineEdit`, and `Write` to `AccessKind::Edit`.

`xai-grok-shell/src/session/acp_session_impl/tool_calls.rs`:

- `access_kind_for_resolved_tool`, lines 167–177, calls `AccessKind::from` for ordinary tools.
- `prepare_tool_call`, starting at line 1445, obtains that access kind at line 1712.
- Lines 1740–1758 contain a separate plan-file auto-approval exception.
- For other calls, lines 1840–1857 submit `PermissionRequest` through `self.permissions.request(...).await`.

`xai-grok-workspace/src/permission/policy.rs:278–320` evaluates deny before ask before allow. A matching `ToolFilter::Any` allow therefore produces `Decision::Allow` for an ordinary edit, absent stronger rules.

`xai-grok-workspace/src/permission/manager/mod.rs:747–787` evaluates policy and handles the separate YOLO branch. With YOLO disabled, the policy still remains.

At `manager/mod.rs:1107–1158`, a policy allow returns a permission resolution and continues without a prompt. Protected targets, forced confirmation, and other special conditions can defer that allow. An ordinary synthetic-workspace edit does not inherently meet those exceptions.

### 5. A real prompt travels over ACP without client filesystem support

When policy and other approvals do not resolve the call, `manager/mod.rs:1368–1371` calls `AcpPrompter::request`.

`xai-grok-workspace/src/permission/prompter.rs:736–799` constructs `acp::RequestPermissionRequest` and calls `self.gateway.request_permission(req).await` for the local ACP route.

`xai-acp-lib/src/gateway.rs:386–393` forwards that request. Its connection dispatcher at line 240 calls `request_permission` on the ACP connection. `xai-acp-lib/src/message.rs:135` identifies the wire method as `session_request_permission`.

The existing server relay then sends ACP messages to the current WebSocket connection. The protocol review documents that shared destination and its newest-connection behavior.

No additional permission-bridge capability is required along this inspected native path. Client filesystem services and permission prompts are independent operations.

## Minimal correction, proposed only

The smallest correction for the observed inherited default is a project-local Claude mode override. It uses Grok's existing resolver and leaves both global files unchanged.

For a trusted synthetic workspace, the proposed `<workspace>/.claude/settings.local.json` content is:

```json
{"permissions":{"defaultMode":"default"}}
```

The resolver selects this explicit local mode instead of the global `bypassPermissions` mode. It therefore does not synthesize the catch-all allow. Existing explicit allow/deny rules still apply. This restores normal ask behavior, not a guarantee that every tool call prompts.

The existing launch flag can remain:

```text
--permission-mode default
```

A fresh session can explicitly use:

```json
{"_meta":{"yoloMode":false,"autoMode":false}}
```

`autoMode:false` prevents a separate automatic classifier mode. It does not erase explicit permission rules.

Folder trust is a prerequisite for the local override. Native `--trust` grants trust to the process working directory and persists that decision. Source: `xai-grok-pager-bin/src/main.rs:1245–1256`. The installed CLI accepted `grok --trust --help` without launching an agent. No trust grant occurred during this review. A future smoke test must grant trust to its synthetic workspace, rather than merely trusting the server's unrelated launch directory.

An alternative native correction is a trusted project `.grok/config.toml` rule:

```toml
[permission]
ask = ["Edit"]
```

That rule overrides the inherited catch-all allow for native edit operations because ask outranks allow. For a smoke test of one write, it is narrower than changing all inherited mode behavior. It does not cover every mutation tool: `ApplyPatch`, for example, maps to a generic tool access kind. The local mode override is the clearer correction for the reported global-default conflict.

No project configuration was created in this review.

## Approaches that do not solve this cause

- Advertising `fs=true` changes the backend. It does not remove the allow rule and requires actual client filesystem handlers.
- Repeating `_meta.yoloMode:false` does not remove the Claude-derived rule.
- `startupHints.permissionMode:"default"` is not a supported override here. `resolution.rs:293–330` honors only `"alwaysAllow"`.
- `GROK_CONFIG` and `GROK_CONFIG_PATH` cannot inject permission rules in this source. `xai-grok-config/src/config_override.rs:100–120` excludes permission keys from the overlay allowlist.
- A custom Pi policy wrapper or a Grok patch is unnecessary for this configuration cause.

## Deciding rerun

The remaining check belongs to the main Pi RPC smoke test. No additional client can connect to port 2419 during that test.

After the native configuration correction, a fresh session must attempt a new ordinary file write. The client must receive `session/request_permission`. A rejection must leave the file unchanged. A separate approval attempt must complete the write.

That rerun distinguishes a working native configuration correction from a source/binary mismatch or an additional approval source. Static inspection alone cannot establish its outcome.
