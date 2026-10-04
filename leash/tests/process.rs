use pi_grok_leash::frame;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, Receiver},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const LEASH: &str = env!("CARGO_BIN_EXE_pi-grok-leash");
const FAKE: &str = env!("CARGO_BIN_EXE_fake-grok");
const HEARTBEAT: &[u8] = b"{\"jsonrpc\":\"2.0\",\"method\":\"pi/heartbeat\"}\n";

struct Harness {
    child: Child,
    input: Arc<Mutex<Option<ChildStdin>>>,
    output: Receiver<Vec<u8>>,
    beating: Arc<AtomicBool>,
    beat_thread: Option<JoinHandle<()>>,
    grok_pid: i32,
}
impl Harness {
    fn new(stall_ms: u64, request_ms: u64, log: Option<&PathBuf>) -> Self {
        let mut command = Command::new(LEASH);
        command.args([
            "--parent",
            &std::process::id().to_string(),
            "--stall-ms",
            &stall_ms.to_string(),
            "--request-ms",
            &request_ms.to_string(),
        ]);
        if let Some(path) = log {
            command.arg("--log").arg(path);
        }
        command.args(["--", FAKE]);
        Self::from_command(command)
    }
    fn from_command(mut command: Command) -> Self {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let input = Arc::new(Mutex::new(child.stdin.take()));
        let stdout = child.stdout.take().unwrap();
        let (tx, output) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                if reader.read_until(b'\n', &mut line).unwrap() == 0 {
                    break;
                }
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let mut h = Self {
            child,
            input,
            output,
            beating: Arc::new(AtomicBool::new(false)),
            beat_thread: None,
            grok_pid: 0,
        };
        let ready = h.line();
        assert!(ready.contains("\"event\":\"ready\""), "first line: {ready}");
        assert!(ready.contains("\"version\":\"0.1.0\""));
        let rest = ready.split("\"grokPid\":").nth(1).unwrap();
        h.grok_pid = rest.split(',').next().unwrap().parse().unwrap();
        h
    }
    fn send(&self, bytes: &[u8]) {
        let mut input = self.input.lock().unwrap();
        let input = input.as_mut().unwrap();
        input.write_all(bytes).unwrap();
        input.flush().unwrap();
    }
    fn line(&self) -> String {
        String::from_utf8(
            self.output
                .recv_timeout(Duration::from_secs(5))
                .expect("leash output timed out"),
        )
        .unwrap()
    }
    fn beats(&mut self) {
        self.beats_every(Duration::from_millis(10));
    }
    fn beats_every(&mut self, interval: Duration) {
        self.beating.store(true, Ordering::SeqCst);
        let beating = Arc::clone(&self.beating);
        let input = Arc::clone(&self.input);
        self.beat_thread = Some(thread::spawn(move || {
            while beating.load(Ordering::SeqCst) {
                if let Some(input) = input.lock().unwrap().as_mut() {
                    if input
                        .write_all(HEARTBEAT)
                        .and_then(|_| input.flush())
                        .is_err()
                    {
                        break;
                    }
                } else {
                    break;
                }
                thread::sleep(interval);
            }
        }));
    }
    fn wait(&mut self) -> ExitStatus {
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(Instant::now() < until, "leash did not exit");
            thread::sleep(Duration::from_millis(2));
        }
    }
    fn eof(&self) {
        self.input.lock().unwrap().take();
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.beating.store(false, Ordering::SeqCst);
        // Kill first, so even a test writer blocked on backpressure is released.
        unsafe {
            libc::kill(-self.grok_pid, libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(thread) = self.beat_thread.take() {
            let _ = thread.join();
        }
    }
}

fn dead(pid: i32) -> bool {
    #[cfg(target_os = "linux")]
    {
        match fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(stat) => stat
                .rsplit_once(')')
                .unwrap()
                .1
                .trim_start()
                .starts_with('Z'),
            Err(_) => true,
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        unsafe { libc::kill(pid, 0) != 0 }
    }
}

#[test]
fn first_ready_and_heartbeat_stall_kills_child() {
    let mut h = Harness::new(150, 500, None);
    let line = h.line();
    assert!(line.contains("\"event\":\"stall\""), "{line}");
    assert!(line.contains("\"ms\":150"));
    assert_eq!(h.wait().code(), Some(0));
    assert!(dead(h.grok_pid));
    assert!(h.output.try_recv().is_err());
}

#[test]
fn deadline_sends_deny_and_late_reply_is_dropped() {
    let mut h = Harness::new(500, 70, None);
    h.beats();
    h.send(b"request\n");
    assert_eq!(
        frame::parse(h.line().as_bytes()).unwrap().method.as_deref(),
        Some("_x.ai/hooks/run")
    );
    let lines = [h.line(), h.line()];
    assert!(lines.iter().any(|s| s == "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"decision\":\"deny\",\"reason\":\"pi-grok-leash: no answer in 70 ms\"}}\n"));
    assert!(lines
        .iter()
        .any(|s| s.contains("\"event\":\"deadline\"") && s.contains("\"ms\":70")));
    h.send(b"{\"id\":1,\"result\":{\"decision\":\"allow\"}}\n");
    assert!(h.line().contains("\"event\":\"late-reply\""));
    h.send(b"{\"marker\":true}\n");
    assert_eq!(h.line(), "{\"marker\":true}\n");
    assert!(
        h.child.try_wait().unwrap().is_none(),
        "deadline must not kill grok"
    );
    h.eof();
    assert!(h.line().contains("\"event\":\"parent-gone\""));
    assert_eq!(h.wait().code(), Some(0));
}

#[test]
fn permission_question_and_extended_deadline() {
    let mut h = Harness::new(500, 250, None);
    h.beats();
    h.send(b"permission\n");
    assert!(h.line().contains("session/request_permission"));
    h.send(b"{\"method\":\"pi/extend\",\"params\":{\"id\":2,\"ms\":500}}\n");
    assert!(h.output.recv_timeout(Duration::from_millis(300)).is_err());
    let lines = [h.line(), h.line()];
    assert!(lines
        .iter()
        .any(|s| s.contains("\"ms\":500") && s.contains("\"event\":\"deadline\"")));
    assert!(lines
        .iter()
        .any(|s| s.contains("\"result\":{\"outcome\":{\"outcome\":\"cancelled\"}}")));
    h.send(b"question\n");
    assert!(h.line().contains("_x.ai/ask_user_question"));
    let lines = [h.line(), h.line()];
    assert!(lines.iter().all(|s| s.contains(r#""id":"a\u0062""#)));
    h.send(b"{\"id\":\"ab\",\"result\":{}}\n");
    assert!(h.line().contains("\"event\":\"late-reply\""));
    h.eof();
    assert_eq!(h.wait().code(), Some(0));
}

#[test]
fn timely_reply_and_byte_exact_forwarding() {
    let mut h = Harness::new(500, 250, None);
    h.beats();
    h.send(b"request\n");
    h.line();
    let response = b" { \"id\" : 1, \"result\" : {\"decision\":\"allow\"} }\r\n";
    h.send(response);
    assert_eq!(h.line().as_bytes(), response);
    h.send(b"{\"method\":\"pi/extend\",\"params\":{\"id\":999,\"ms\":1000}}\n");
    let malformed = b"not JSON \t\r\n";
    h.send(malformed);
    assert_eq!(h.line().as_bytes(), malformed);
    let nested = b"{\"params\":{\"method\":\"pi/heartbeat\"},\"x\":1}\n";
    h.send(nested);
    assert_eq!(h.line().as_bytes(), nested);
    assert!(h.output.recv_timeout(Duration::from_millis(300)).is_err());
    h.eof();
    assert_eq!(h.wait().code(), Some(0));
}

#[test]
fn overflow_kills_instead_of_answering_65_requests() {
    let mut h = Harness::new(1000, 5000, None);
    h.beats();
    h.send(b"overflow\n");
    let mut count = 0;
    loop {
        let line = h.line();
        if line.contains("\"event\":\"stall\"") {
            break;
        }
        assert!(line.contains("_x.ai/hooks/run"));
        count += 1;
    }
    assert_eq!(count, 64);
    assert_eq!(h.wait().code(), Some(0));
    assert!(dead(h.grok_pid));
}

#[test]
fn child_exit_passthrough_drains_buffered_output() {
    let mut h = Harness::new(1000, 1000, None);
    h.beats();
    h.send(b"exit7\n");
    for n in 0..1000 {
        assert_eq!(h.line(), format!("{{\"tail\":{n}}}\n"));
    }
    let exit = h.line();
    assert!(exit.contains("\"event\":\"child-exit\""));
    assert!(exit.contains("\"code\":7,\"signal\":null"));
    assert_eq!(h.wait().code(), Some(7));
}

#[test]
fn signalled_child_exit_passthrough() {
    let mut h = Harness::new(1000, 1000, None);
    h.send(b"signal\n");
    let exit = h.line();
    assert!(exit.contains("\"code\":null,\"signal\":\"SIGTERM\""));
    assert_eq!(h.wait().code(), Some(128 + libc::SIGTERM));
}

#[test]
fn stdin_eof_kills_and_reaps_child() {
    let mut h = Harness::new(1000, 1000, None);
    h.eof();
    assert!(h.line().contains("\"event\":\"parent-gone\""));
    assert_eq!(h.wait().code(), Some(0));
    assert!(dead(h.grok_pid));
}

#[test]
#[cfg(target_os = "linux")]
fn parent_sigkill_kills_fake_within_500_ms() {
    // Reap orphaned leash/fake ourselves rather than relying on container PID 1.
    assert_eq!(unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1) }, 0);
    let mut command = Command::new(FAKE);
    command.args(["--parent-helper", LEASH]);
    let mut h = Harness::from_command(command);
    let stat = fs::read_to_string(format!("/proc/{}/stat", h.grok_pid)).unwrap();
    let leash_pid: i32 = stat
        .rsplit_once(')')
        .unwrap()
        .1
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let start = Instant::now();
    h.child.kill().unwrap();
    h.child.wait().unwrap();
    while !dead(h.grok_pid) {
        assert!(
            start.elapsed() < Duration::from_millis(500),
            "fake survived parent death"
        );
        thread::sleep(Duration::from_millis(2));
    }
    assert!(start.elapsed() < Duration::from_millis(500));
    unsafe {
        libc::waitpid(leash_pid, std::ptr::null_mut(), 0);
        libc::waitpid(h.grok_pid, std::ptr::null_mut(), 0);
    }
}

#[test]
fn logs_append_events_args_and_malformed_counter() {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let path = std::env::temp_dir().join(format!(
        "pi-grok-leash-test-{}-{}.log",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    fs::write(&path, "existing\n").unwrap();
    let mut h = Harness::new(1000, 1000, Some(&path));
    h.send(b"malformed\n");
    assert_eq!(h.line(), "malformed\n");
    h.eof();
    assert_eq!(h.wait().code(), Some(0));
    let log = fs::read_to_string(&path).unwrap();
    fs::remove_file(path).unwrap();
    assert!(log.starts_with("existing\n"));
    for token in [
        "\"event\":\"start\"",
        "\"args\":[",
        "\"event\":\"ready\"",
        "\"event\":\"parent-gone\"",
        "\"malformed\":2",
    ] {
        assert!(log.contains(token), "{token}: {log}");
    }
}

#[test]
fn cli_version_usage_and_parent_mismatch() {
    let version = Command::new(LEASH).arg("--version").output().unwrap();
    assert!(version.status.success());
    assert!(String::from_utf8(version.stdout)
        .unwrap()
        .starts_with("pi-grok-leash 0.1.0"));
    let bad = Command::new(LEASH).arg("--bad").output().unwrap();
    assert_eq!(bad.status.code(), Some(2));
    assert!(String::from_utf8(bad.stderr).unwrap().starts_with("usage:"));
    #[cfg(target_os = "linux")]
    {
        let mismatch = Command::new(LEASH)
            .args(["--parent", "1", "--", FAKE])
            .output()
            .unwrap();
        assert_eq!(mismatch.status.code(), Some(3));
        assert!(mismatch.stdout.is_empty());
    }
}

#[test]
fn blocked_child_input_does_not_block_watchdog_kill() {
    let mut h = Harness::new(200, 1000, None);
    h.send(b"block\n");
    assert_eq!(h.line(), "{\"blocked\":true}\n");
    let input = Arc::clone(&h.input);
    let writer = thread::spawn(move || {
        let mut input = input.lock().unwrap();
        if let Some(input) = input.as_mut() {
            let mut line = vec![b'x'; 1024 * 1024];
            line.push(b'\n');
            let _ = input.write_all(&line);
        }
    });
    assert!(h.line().contains("\"event\":\"stall\""));
    assert_eq!(h.wait().code(), Some(0));
    writer.join().unwrap();
    assert!(dead(h.grok_pid));
}

#[test]
fn queued_forwarding_keeps_heartbeats_live_while_grok_pauses_reading() {
    let mut command = Command::new(LEASH);
    command.args([
        "--parent",
        &std::process::id().to_string(),
        "--stall-ms",
        "300",
        "--",
        FAKE,
        "--delay-read",
    ]);
    let mut h = Harness::from_command(command);
    h.beats_every(Duration::from_millis(50));
    let started = Instant::now();
    let lines: Vec<_> = (0..800).map(|sequence| {
        format!("{{\"jsonrpc\":\"2.0\",\"id\":99,\"result\":{{\"sequence\":{sequence},\"padding\":\"{}\"}}}}\n", "x".repeat(256))
    }).collect();
    assert!(lines.iter().map(String::len).sum::<usize>() > 128 * 1024);
    // Release the harness input mutex after each line so its heartbeat sender
    // can interleave controls during the burst as well as during the pause.
    for line in &lines {
        h.send(line.as_bytes());
    }
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "burst blocked behind grok's pipe"
    );
    for expected in &lines {
        assert_eq!(
            &h.line(),
            expected,
            "queued lines must be delivered once and in order, with no stall event"
        );
    }
    let remaining = Duration::from_millis(3500).saturating_sub(started.elapsed());
    assert!(
        h.output.recv_timeout(remaining).is_err(),
        "unexpected event while heartbeats are flowing"
    );
    assert!(!dead(h.grok_pid));
    assert!(h.child.try_wait().unwrap().is_none());
    h.eof();
    assert!(h.line().contains("\"event\":\"parent-gone\""));
    assert_eq!(h.wait().code(), Some(0));
}

#[test]
fn forwards_unterminated_final_bytes_unchanged() {
    let mut h = Harness::new(1000, 1000, None);
    h.send(b"partial\n");
    let line = h.line();
    assert!(line.starts_with("unterminated{\"jsonrpc\":"));
    assert!(line.contains("\"event\":\"child-exit\""));
    assert_eq!(h.wait().code(), Some(0));
}
