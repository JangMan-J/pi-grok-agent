use std::{ffi::OsString, path::PathBuf};

pub const USAGE: &str = "usage: pi-grok-leash --parent <pid> [--stall-ms 1000] [--request-ms 25000] [--log <path>] -- <grok> <args...> | --version";

#[derive(Debug, PartialEq)]
pub struct Options {
    pub parent: libc::pid_t,
    pub stall_ms: u64,
    pub request_ms: u64,
    pub log: Option<PathBuf>,
    pub command: Vec<OsString>,
}

#[derive(Debug, PartialEq)]
pub enum Invocation {
    Version,
    Run(Options),
}

pub fn version() -> String {
    format!(
        "pi-grok-leash {}{}",
        env!("CARGO_PKG_VERSION"),
        if cfg!(target_os = "linux") {
            ""
        } else {
            " (eof-only)"
        }
    )
}

pub fn parse(args: Vec<OsString>, log_env: Option<OsString>) -> Result<Invocation, &'static str> {
    if args == ["--version"] {
        return Ok(Invocation::Version);
    }
    let mut parent = None;
    let mut stall_ms = 1000;
    let mut request_ms = 25000;
    let mut log = log_env.map(PathBuf::from);
    let mut args = args.into_iter();
    while let Some(flag) = args.next() {
        if flag == "--" {
            let command: Vec<_> = args.collect();
            if command.is_empty() || command[0].is_empty() {
                return Err(USAGE);
            }
            return Ok(Invocation::Run(Options {
                parent: parent.ok_or(USAGE)?,
                stall_ms,
                request_ms,
                log,
                command,
            }));
        }
        let value = args.next().ok_or(USAGE)?;
        match flag.to_str() {
            Some("--parent") => {
                let pid: libc::pid_t = value.to_str().ok_or(USAGE)?.parse().map_err(|_| USAGE)?;
                if pid <= 0 {
                    return Err(USAGE);
                }
                parent = Some(pid);
            }
            Some("--stall-ms") | Some("--request-ms") => {
                let ms: u64 = value.to_str().ok_or(USAGE)?.parse().map_err(|_| USAGE)?;
                if ms == 0 {
                    return Err(USAGE);
                }
                if flag == "--stall-ms" {
                    stall_ms = ms;
                } else {
                    request_ms = ms;
                }
            }
            Some("--log") if !value.is_empty() => log = Some(value.into()),
            _ => return Err(USAGE),
        }
    }
    Err(USAGE)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parse_args(args: &[&str]) -> Result<Invocation, &'static str> {
        parse(args.iter().map(OsString::from).collect(), None)
    }
    #[test]
    fn version_and_defaults() {
        assert_eq!(parse_args(&["--version"]), Ok(Invocation::Version));
        let Invocation::Run(options) =
            parse_args(&["--parent", "42", "--", "grok", "stdio"]).unwrap()
        else {
            panic!()
        };
        assert_eq!(options.parent, 42);
        assert_eq!(options.stall_ms, 1000);
        assert_eq!(options.request_ms, 25000);
        assert_eq!(options.command, ["grok", "stdio"]);
        assert!(version().starts_with("pi-grok-leash 0.1.0"));
    }
    #[test]
    fn flags_and_environment() {
        let Invocation::Run(options) = parse(
            [
                "--parent",
                "1",
                "--stall-ms",
                "20",
                "--request-ms",
                "30",
                "--log",
                "explicit.log",
                "--",
                "grok",
            ]
            .iter()
            .map(OsString::from)
            .collect(),
            Some("env.log".into()),
        )
        .unwrap() else {
            panic!()
        };
        assert_eq!((options.stall_ms, options.request_ms), (20, 30));
        assert_eq!(options.log, Some("explicit.log".into()));
        let Invocation::Run(options) = parse(
            ["--parent", "1", "--", "grok"]
                .iter()
                .map(OsString::from)
                .collect(),
            Some("env.log".into()),
        )
        .unwrap() else {
            panic!()
        };
        assert_eq!(options.log, Some("env.log".into()));
    }
    #[test]
    fn rejects_bad_flags() {
        for args in [
            vec![],
            vec!["--"],
            vec!["--parent", "0", "--", "grok"],
            vec!["--parent", "42"],
            vec!["--version", "extra"],
            vec!["--unknown", "x"],
            vec!["--parent", "42", "--stall-ms", "0", "--", "grok"],
            vec!["--parent", "42", "--request-ms", "no", "--", "grok"],
        ] {
            assert_eq!(parse_args(&args), Err(USAGE));
        }
    }
}
