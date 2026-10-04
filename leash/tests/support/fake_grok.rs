use std::{
    io::{self, BufRead, BufReader, Write},
    process::{Command, Stdio},
};

fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).is_some_and(|arg| arg == "--parent-helper") {
        let mut child = Command::new(&args[2])
            .args([
                "--parent",
                &std::process::id().to_string(),
                "--stall-ms",
                "5000",
                "--",
            ])
            .arg(&args[0])
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        std::process::exit(child.wait().unwrap().code().unwrap_or(1));
    }
    if args.get(1).is_some_and(|arg| arg == "--delay-read") {
        std::thread::sleep(std::time::Duration::from_secs(3));
    }
    let mut input = BufReader::new(io::stdin());
    let mut output = io::stdout().lock();
    let mut line = Vec::new();
    loop {
        line.clear();
        if input.read_until(b'\n', &mut line).unwrap() == 0 {
            break;
        }
        match line.as_slice() {
            b"request\n" => writeln!(
                output,
                r#"{{"jsonrpc":"2.0","id":1,"method":"_x.ai/hooks/run"}}"#
            )
            .unwrap(),
            b"permission\n" => writeln!(
                output,
                r#"{{"jsonrpc":"2.0","id":2,"method":"session/request_permission"}}"#
            )
            .unwrap(),
            b"question\n" => writeln!(
                output,
                r#"{{"jsonrpc":"2.0","id":"a\u0062","method":"_x.ai/ask_user_question"}}"#
            )
            .unwrap(),
            b"exit7\n" => {
                for n in 0..1000 {
                    writeln!(output, r#"{{"tail":{n}}}"#).unwrap();
                }
                output.flush().unwrap();
                std::process::exit(7);
            }
            b"signal\n" => unsafe {
                libc::kill(libc::getpid(), libc::SIGTERM);
            },
            b"overflow\n" => {
                for id in 0..65 {
                    writeln!(output, r#"{{"id":{id},"method":"_x.ai/hooks/run"}}"#).unwrap();
                }
            }
            b"block\n" => {
                writeln!(output, r#"{{"blocked":true}}"#).unwrap();
                output.flush().unwrap();
                loop {
                    std::thread::park();
                }
            }
            b"partial\n" => {
                output.write_all(b"unterminated").unwrap();
                output.flush().unwrap();
                return;
            }
            _ => output.write_all(&line).unwrap(),
        }
        output.flush().unwrap();
    }
}
