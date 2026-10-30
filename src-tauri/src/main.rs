use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::Command;

use serde_json::{json, Value};
use tauri::{Manager, Webview};

/// The scenario config, passed in by `run.mjs` through `REPRO_CONFIG`.
#[tauri::command]
fn config() -> Value {
    let raw = std::env::var("REPRO_CONFIG").unwrap_or_else(|_| "{}".into());
    serde_json::from_str(&raw).unwrap_or(json!({}))
}

/// Counts the entries in this webview's resource table, by type name.
#[tauri::command]
fn resources(webview: Webview) -> BTreeMap<String, usize> {
    let table = webview.resources_table();
    let mut counts = BTreeMap::new();
    for (_, name) in table.names() {
        let short = name.rsplit("::").next().unwrap_or(&name).to_string();
        *counts.entry(short).or_insert(0) += 1;
    }
    counts
}

/// Process and socket numbers, measured from outside the webview.
#[tauri::command]
fn snapshot(port: u16, stats_port: u16) -> Value {
    let pid = std::process::id();

    let rss_kb: u64 = run("ps", &["-o", "rss=", "-p", &pid.to_string()])
        .trim()
        .parse()
        .unwrap_or(0);
    let fds = run("lsof", &["-n", "-P", "-p", &pid.to_string()])
        .lines()
        .count()
        .saturating_sub(1);

    // Client side of every established connection to the test server, by process.
    let mut client_sockets: BTreeMap<String, usize> = BTreeMap::new();
    let target = format!("->127.0.0.1:{port} ");
    for line in run("lsof", &["-n", "-P", &format!("-iTCP:{port}"), "-sTCP:ESTABLISHED"]).lines() {
        if !line.contains(&target) {
            continue;
        }
        let mut cols = line.split_whitespace();
        let _command = cols.next();
        let owner = match cols.next() {
            Some(p) if p == pid.to_string() => "app".to_string(),
            Some(p) => run("ps", &["-o", "comm=", "-p", p])
                .trim()
                .rsplit('/')
                .next()
                .unwrap_or("?")
                .to_string(),
            None => continue,
        };
        *client_sockets.entry(owner).or_insert(0) += 1;
    }

    json!({
        "rssKb": rss_kb,
        "fds": fds,
        "clientSockets": client_sockets,
        "server": server_stats(stats_port),
    })
}

/// Prints the result on stdout and quits. `run.mjs` writes the file: when the
/// app has run out of file descriptors, it cannot open one itself.
#[tauri::command]
fn finish(app: tauri::AppHandle, result: Value) {
    println!("RESULT {}", serde_json::to_string(&result).unwrap());
    app.exit(0);
}

#[tauri::command]
fn log(message: String) {
    eprintln!("[page] {message}");
}

fn run(cmd: &str, args: &[&str]) -> String {
    Command::new(cmd)
        .args(args)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

fn server_stats(stats_port: u16) -> Value {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", stats_port)) else {
        return Value::Null;
    };
    let _ = stream.write_all(b"GET / HTTP/1.0\r\n\r\n");
    let mut buf = String::new();
    let _ = stream.read_to_string(&mut buf);
    let body = buf.split("\r\n\r\n").nth(1).unwrap_or("null");
    serde_json::from_str(body).unwrap_or(Value::Null)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![config, resources, snapshot, finish, log])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
