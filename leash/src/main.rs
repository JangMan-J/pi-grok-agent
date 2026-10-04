use pi_grok_leash::{
    cli::{self, Invocation},
    runtime,
};

fn main() {
    let invocation = cli::parse(
        std::env::args_os().skip(1).collect(),
        std::env::var_os("PI_GROK_LEASH_LOG"),
    );
    let code = match invocation {
        Ok(Invocation::Version) => {
            println!("{}", cli::version());
            0
        }
        Ok(Invocation::Run(options)) => match runtime::arm_parent(options.parent) {
            Ok(false) => 3,
            Ok(true) => match runtime::run(options) {
                Ok(code) => code,
                Err(error) => {
                    eprintln!("pi-grok-leash: {error}");
                    1
                }
            },
            Err(error) => {
                eprintln!("pi-grok-leash: {error}");
                1
            }
        },
        Err(usage) => {
            eprintln!("{usage}");
            2
        }
    };
    // Forwarders can be blocked on Pi's stdin; process exit closes them without
    // waiting for a peer that is no longer participating in the protocol.
    std::process::exit(code);
}
