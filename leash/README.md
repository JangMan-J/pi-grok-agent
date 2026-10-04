# pi-grok-leash

Standalone Rust 2021, Unix stdio watchdog. Build from the repository root with
`npm run build:leash`, or run `cargo build --release` from this directory.
The production binary is `target/release/pi-grok-leash`; `fake-grok` is only a
local test helper. The only dependency is `libc`. Release builds use size
optimization (`opt-level = "z"`), LTO, one codegen unit, aborting panics, and stripping.

```
pi-grok-leash --parent <pi-pid> [--stall-ms 1000] [--request-ms 25000] [--log <path>] -- <grok> <args...>
```

`PI_GROK_LEASH_LOG` supplies the default append-only log path. An explicit
`--log` wins. Logs contain start/args, every leash event, and an exit record
with the count of malformed lines observed across both directions.

## Implementation and contract readings

- `src/frame.rs` validates JSON objects with a depth-limited hand parser.
  Forwarding uses the original bytes, never a reserialized object. String IDs
  compare after unescaping; synthetic replies retain the original ID token.
- `src/tracker.rs` owns deadline claims under one mutex. An extension for an
  expired/answered ID is ignored, even before the timer processes expiration.
  `deadline.ms` and the denial reason use the most recent deadline length
  (the initial request length or the latest accepted extension). Zero-length
  extensions expire immediately; negative/non-integer extensions are ignored.
- `src/runtime.rs` starts a Pi reader, a grok writer, a grok-to-Pi forwarder,
  and a timer. The Pi reader updates an atomic monotonic heartbeat timestamp
  and applies extensions immediately, then puts non-control lines onto an
  unbounded `std::sync::mpsc` queue. The grok writer drains that queue and also
  writes synthetic replies. Each output has one `Mutex<BufWriter>` and flushes
  after each line. Blocked writes cannot prevent heartbeat consumption or the
  timer's group kill. Per the Manager's clarification, Pi-to-grok is intentionally
  queue-buffered: there is no backpressure from grok to Pi in that direction,
  no queue capacity limit, and sustained input can grow memory use. Grok-to-Pi
  still has natural pipe backpressure.
- `ready` precedes starting the forwarders. On natural child exit, buffered
  stdout drains before `child-exit`. Leash-initiated kills produce only `stall`
  or `parent-gone`, not `child-exit`. Competing terminal causes use the first
  observed cause. The 65th pending request is not forwarded and produces
  `stall.ms = stall-ms`.
- Heartbeats re-baseline at receipt. To avoid a timer beating the first resumed
  heartbeat to the lock, a timer scheduling gap greater than `10 * stall-ms`
  also re-baselines. All measurements use `Instant`; on Linux its underlying
  monotonic clock excludes actual machine suspend time. Tests inject timestamps
  for the re-baseline case; no claim of a live laptop-suspend test is made.
- Final unterminated bytes are forwarded unchanged. Consequently an event can
  immediately follow those bytes without an intervening newline: invalid NDJSON
  input is not repaired. The input protocol is newline-terminated NDJSON.
- A blocked grok stdin does not starve Pi heartbeat or extension handling. A
  blocked Pi stdout delays event delivery and leash exit until the reader
  resumes, but the timer kills grok's group before attempting to deliver the
  terminal event. EOF still kills immediately, rather than draining queued
  Pi-to-grok lines after the parent has disconnected.
- Linux arms `PR_SET_PDEATHSIG` both for the leash and in grok's pre-exec and
  checks parent identity after arming each. Other Unix targets use EOF and
  parent-identity polling, and `--version` reports `(eof-only)`. Non-Linux
  compilation/runtime behavior has not been verified here.

## Residual limits

A Pi stall shorter than `stall-ms` is not stopped. Group kills reach only
processes still in grok's group: tools that moved into another group can keep
running. Abrupt Linux parent death kills the leash and its immediate grok child
via parent-death signals; those signals do not themselves kill grok's entire
process group. Orderly EOF, detected stalls, and detected parent-identity changes
explicitly kill the group. An abrupt kill cannot write an exit log/event.
Whole-machine suspension stops execution; monotonic timing and the re-baseline
rule avoid treating the suspend interval itself as an ordinary heartbeat stall.

## Verification

`cargo test` uses only the Rust fake child in `tests/support/fake_grok.rs`.
No tests contact Grok or xAI. Unit tests cover CLI parsing, frame classification,
escaping/nested fields, malformed input, deadlines, extensions, the 64-request
limit, and suspend re-baselining. `tests/process.rs` covers readiness, stalls,
synthetic results for all three methods, string IDs, late replies, byte-exact
forwarding, overflow, EOF cleanup, buffered output before exit, exit codes and
signals, logs, parent mismatch, blocked child input, and Linux parent death
within 500 ms. The queued-input regression pauses fake grok's reads for 3 s,
uses stall-ms 300 and heartbeats every 50 ms, then checks more than 128 KiB
(800 lines) arrives byte-for-byte in order with no stall over 3.5 s. A Linux
zombie is considered dead (not running), then reaped by the test.

```
cargo build --release
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```
