use crate::{
    cli::Options,
    frame::{self, quote},
    tracker::{Heartbeat, Request, Tracker},
};
use std::{
    fs::{File, OpenOptions},
    io::{self, BufRead, BufReader, BufWriter, Write},
    os::unix::process::{CommandExt, ExitStatusExt},
    process::{ChildStdin, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Sender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

type PiOutput = Mutex<BufWriter<io::Stdout>>;
type GrokInput = Mutex<BufWriter<ChildStdin>>;

struct Shared {
    pid: libc::pid_t,
    parent: libc::pid_t,
    stall_ms: u64,
    request_ms: u64,
    pi: PiOutput,
    grok: GrokInput,
    tracker: Mutex<Tracker>,
    heartbeat: Mutex<Heartbeat>,
    stopping: AtomicBool,
    child_exited: AtomicBool,
    malformed: AtomicU64,
    log: Mutex<Option<BufWriter<File>>>,
    messages: Sender<Message>,
}

enum Message {
    Stop(&'static str),
    Expired(Vec<Request>),
    OutputClosed,
}

fn write_line(writer: &mut impl Write, line: &[u8]) -> io::Result<()> {
    writer.write_all(line)?;
    writer.flush()
}

impl Shared {
    fn log(&self, line: &str) {
        if let Some(log) = self.log.lock().unwrap().as_mut() {
            let _ = writeln!(log, "{line}").and_then(|_| log.flush());
        }
    }
    fn event(&self, event: &str, fields: &str) -> io::Result<()> {
        let comma = if fields.is_empty() { "" } else { "," };
        let line = format!(
            r#"{{"jsonrpc":"2.0","method":"pi/leash","params":{{"event":"{event}"{comma}{fields}}}}}"#
        );
        self.log(&line);
        write_line(
            &mut *self.pi.lock().unwrap(),
            format!("{line}\n").as_bytes(),
        )
    }
    // Killing never waits for either protocol writer or the request-tracker lock.
    fn stop(&self, event: &'static str) {
        if !self.stopping.swap(true, Ordering::SeqCst) {
            unsafe {
                libc::kill(-self.pid, libc::SIGKILL);
            }
            let _ = self.messages.send(Message::Stop(event));
        }
    }
    fn expired(&self, now: Instant) {
        let expired = self.tracker.lock().unwrap().expire(now);
        if !expired.is_empty() {
            let _ = self.messages.send(Message::Expired(expired));
        }
    }
    fn parsed(&self, line: &[u8]) -> Option<frame::Frame> {
        let parsed = frame::parse(line);
        if parsed.is_none() {
            self.malformed.fetch_add(1, Ordering::Relaxed);
        }
        parsed
    }
}

/// Arm before spawning anything, then close the parent-death race.
pub fn arm_parent(parent: libc::pid_t) -> io::Result<bool> {
    #[cfg(target_os = "linux")]
    unsafe {
        if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(libc::getppid() == parent)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = parent;
        Ok(true)
    }
}

pub fn run(options: Options) -> io::Result<i32> {
    let log = options
        .log
        .as_ref()
        .map(|path| OpenOptions::new().create(true).append(true).open(path))
        .transpose()?;
    let leash_pid = std::process::id() as libc::pid_t;
    let mut command = Command::new(&options.command[0]);
    command
        .args(&options.command[1..])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .process_group(0);
    unsafe {
        command.pre_exec(move || {
            #[cfg(target_os = "linux")]
            {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::getppid() != leash_pid {
                    libc::_exit(3);
                }
            }
            #[cfg(not(target_os = "linux"))]
            let _ = leash_pid;
            Ok(())
        });
    }
    let mut child = command.spawn()?;
    let pid = child.id() as libc::pid_t;
    let child_stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let shared = Arc::new(Shared {
        pid,
        parent: options.parent,
        stall_ms: options.stall_ms,
        request_ms: options.request_ms,
        pi: Mutex::new(BufWriter::new(io::stdout())),
        grok: Mutex::new(BufWriter::new(child.stdin.take().unwrap())),
        tracker: Mutex::new(Tracker::default()),
        heartbeat: Mutex::new(Heartbeat::new(Instant::now(), options.stall_ms)),
        stopping: AtomicBool::new(false),
        child_exited: AtomicBool::new(false),
        malformed: AtomicU64::new(0),
        log: Mutex::new(log.map(BufWriter::new)),
        messages: tx,
    });
    shared.log(&format!(
        r#"{{"event":"start","parent":{},"args":[{}]}}"#,
        options.parent,
        options
            .command
            .iter()
            .map(|arg| quote(&arg.to_string_lossy()))
            .collect::<Vec<_>>()
            .join(",")
    ));
    if let Err(error) = shared.event(
        "ready",
        &format!(
            r#""version":"{}","grokPid":{pid},"stallMs":{},"requestMs":{}"#,
            env!("CARGO_PKG_VERSION"),
            options.stall_ms,
            options.request_ms
        ),
    ) {
        shared.stop("parent-gone");
        let _ = child.wait();
        return Err(error);
    }

    let pi = Arc::clone(&shared);
    thread::Builder::new()
        .name("pi-to-grok".into())
        .spawn(move || {
            let mut input = BufReader::new(io::stdin());
            let mut line = Vec::new();
            loop {
                line.clear();
                match input.read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => {
                        pi.stop("parent-gone");
                        break;
                    }
                    Ok(_) => (),
                }
                if pi.stopping.load(Ordering::SeqCst) {
                    break;
                }
                if let Some(frame) = pi.parsed(&line) {
                    match frame.method.as_deref() {
                        Some("pi/heartbeat") => {
                            pi.heartbeat.lock().unwrap().beat(Instant::now());
                            continue;
                        }
                        Some("pi/extend") => {
                            if let Some((id, ms)) = frame.extension {
                                pi.tracker.lock().unwrap().extend(&id, ms, Instant::now());
                            }
                            continue;
                        }
                        None => {
                            if let Some(id) = frame.id {
                                // Expire and claim replies atomically, even between timer ticks.
                                let (expired, late) = {
                                    let mut tracker = pi.tracker.lock().unwrap();
                                    let expired = tracker.expire(Instant::now());
                                    (expired, tracker.reply(&id))
                                };
                                if !expired.is_empty() {
                                    let _ = pi.messages.send(Message::Expired(expired));
                                }
                                if late {
                                    if pi
                                        .event("late-reply", &format!(r#""id":{}"#, id.raw))
                                        .is_err()
                                    {
                                        pi.stop("parent-gone");
                                        break;
                                    }
                                    continue;
                                }
                            }
                        }
                        _ => (),
                    }
                }
                if write_line(&mut *pi.grok.lock().unwrap(), &line).is_err() {
                    break;
                }
            }
        })
        .inspect_err(|_| {
            shared.stop("parent-gone");
            let _ = child.wait();
        })?;

    let grok = Arc::clone(&shared);
    thread::Builder::new()
        .name("grok-to-pi".into())
        .spawn(move || {
            let mut input = BufReader::new(child_stdout);
            let mut line = Vec::new();
            loop {
                line.clear();
                match input.read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => (),
                }
                if grok.stopping.load(Ordering::SeqCst) && !grok.child_exited.load(Ordering::SeqCst)
                {
                    break;
                }
                let frame = grok.parsed(&line);
                // Acquire stdout before tracking so a deadline event cannot overtake its request.
                let mut output = grok.pi.lock().unwrap();
                if let Some(frame::Frame {
                    method: Some(method),
                    id: Some(id),
                    ..
                }) = frame
                {
                    if frame::tracked(&method)
                        && !grok.tracker.lock().unwrap().track(
                            id,
                            method,
                            grok.request_ms,
                            Instant::now(),
                        )
                    {
                        grok.stop("stall");
                        break;
                    }
                }
                if write_line(&mut *output, &line).is_err() {
                    grok.stop("parent-gone");
                    break;
                }
            }
            let _ = grok.messages.send(Message::OutputClosed);
        })
        .inspect_err(|_| {
            shared.stop("parent-gone");
            let _ = child.wait();
        })?;

    let timer = Arc::clone(&shared);
    thread::Builder::new()
        .name("leash-timer".into())
        .spawn(move || {
            while !timer.stopping.load(Ordering::SeqCst) {
                if unsafe { libc::getppid() } != timer.parent {
                    timer.stop("parent-gone");
                    break;
                }
                let now = Instant::now();
                if timer.heartbeat.lock().unwrap().stalled(now) {
                    timer.stop("stall");
                    break;
                }
                timer.expired(now);
                thread::sleep(Duration::from_millis(2));
            }
        })
        .inspect_err(|_| {
            shared.stop("parent-gone");
            let _ = child.wait();
        })?;

    // The timer only queues deadline work. Blocking writes here cannot prevent it
    // killing the group when Pi stalls (including backpressure on either pipe).
    let mut status = None;
    let mut output_closed = false;
    let result = loop {
        match rx.recv_timeout(Duration::from_millis(2)) {
            Ok(Message::Stop(event)) => {
                let _ = child.wait();
                let fields = if event == "stall" {
                    format!(r#""ms":{}"#, shared.stall_ms)
                } else {
                    String::new()
                };
                let _ = shared.event(event, &fields);
                break 0;
            }
            Ok(Message::Expired(requests)) => {
                for request in requests {
                    if shared.stopping.load(Ordering::SeqCst) {
                        break;
                    }
                    let response = format!("{}\n", request.synthetic());
                    if write_line(&mut *shared.grok.lock().unwrap(), response.as_bytes()).is_ok()
                        && shared.event("deadline", &request.event_fields()).is_err()
                    {
                        shared.stop("parent-gone");
                    }
                }
            }
            Ok(Message::OutputClosed) => output_closed = true,
            Err(mpsc::RecvTimeoutError::Timeout) => (),
            Err(mpsc::RecvTimeoutError::Disconnected) => unreachable!(),
        }
        if status.is_none() {
            match child.try_wait() {
                Ok(Some(exit)) => {
                    shared.child_exited.store(true, Ordering::SeqCst);
                    if !shared.stopping.swap(true, Ordering::SeqCst) {
                        status = Some(exit);
                    }
                }
                Ok(None) => (),
                Err(error) => {
                    shared.stop("parent-gone");
                    let _ = child.wait();
                    return Err(error);
                }
            }
        }
        if let Some(status) = status {
            if output_closed {
                let _ = shared.event("child-exit", &exit_fields(status));
                break status
                    .code()
                    .unwrap_or_else(|| 128 + status.signal().unwrap_or(0));
            }
        }
    };
    shared.log(&format!(
        r#"{{"event":"exit","code":{result},"malformed":{}}}"#,
        shared.malformed.load(Ordering::Relaxed)
    ));
    Ok(result)
}

fn exit_fields(status: ExitStatus) -> String {
    let code = status.code().map_or("null".into(), |code| code.to_string());
    let signal = status
        .signal()
        .map_or("null".into(), |signal| quote(&signal_name(signal)));
    format!(r#""code":{code},"signal":{signal}"#)
}

fn signal_name(signal: i32) -> String {
    let name = match signal {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGTRAP => "SIGTRAP",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGUSR2 => "SIGUSR2",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        libc::SIGCHLD => "SIGCHLD",
        libc::SIGCONT => "SIGCONT",
        libc::SIGSTOP => "SIGSTOP",
        libc::SIGTSTP => "SIGTSTP",
        libc::SIGTTIN => "SIGTTIN",
        libc::SIGTTOU => "SIGTTOU",
        libc::SIGURG => "SIGURG",
        libc::SIGXCPU => "SIGXCPU",
        libc::SIGXFSZ => "SIGXFSZ",
        libc::SIGVTALRM => "SIGVTALRM",
        libc::SIGPROF => "SIGPROF",
        libc::SIGWINCH => "SIGWINCH",
        libc::SIGIO => "SIGIO",
        libc::SIGSYS => "SIGSYS",
        _ => return format!("SIG{signal}"),
    };
    name.into()
}
