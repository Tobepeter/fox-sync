//! DEV 调试：本机探针 HTTP 入口和模拟 Syncthing 状态，正式构建不编译
use crate::AppState;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{mpsc, Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Manager};

pub const DEFAULT_PORT: u16 = 5196;
static PENDING: OnceLock<Mutex<HashMap<String, mpsc::Sender<Value>>>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<String, mpsc::Sender<Value>>> {
    PENDING.get_or_init(Default::default)
}

/// scripts/probe.mjs 把表达式 POST 到这里，在主窗口里求值后返回 JSON；d 指代 window.__DEBUG__
pub fn start(app: &AppHandle) {
    let port = std::env::var("FOX_SYNC_PROBE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[probe] 端口 {port} 不可用：{e}");
            return;
        }
    };
    eprintln!("[probe] http://127.0.0.1:{port}/eval");
    let app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || {
                let _ = handle(&app, stream);
            });
        }
    });
}

fn handle(app: &AppHandle, mut stream: TcpStream) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut length = 0usize;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header)?;
        if header.trim().is_empty() {
            break;
        }
        if let Some(v) = header.to_ascii_lowercase().strip_prefix("content-length:") {
            length = v.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; length.min(1 << 20)];
    reader.read_exact(&mut body)?;
    let result = if line.starts_with("POST /eval") {
        evaluate(app, &String::from_utf8_lossy(&body))
    } else {
        json!({ "ok": false, "error": "只支持 POST /eval" })
    };
    let text = result.to_string();
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        text.len(),
        text
    )
}

fn evaluate(app: &AppHandle, expression: &str) -> Value {
    let Some(window) = app.get_webview_window("main") else {
        return json!({ "ok": false, "error": "主窗口不存在" });
    };
    let id = uuid::Uuid::new_v4().to_string();
    let (send, receive) = mpsc::channel();
    pending().lock().unwrap().insert(id.clone(), send);
    let script = format!(
        r#"(async () => {{
  const id = {id:?}
  const d = window.__DEBUG__
  let reply
  try {{
    const value = await ({expression}
)
    reply = {{ id, ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) }}
  }} catch (e) {{
    reply = {{ id, ok: false, error: String(e) + (e && e.stack ? '\n' + e.stack : '') }}
  }}
  window.__TAURI_INTERNALS__.invoke('debug_reply', {{ reply }})
}})()"#
    );
    if let Err(e) = window.eval(&script) {
        pending().lock().unwrap().remove(&id);
        return json!({ "ok": false, "error": e.to_string() });
    }
    let result = receive
        .recv_timeout(Duration::from_secs(30))
        .unwrap_or_else(|_| json!({ "ok": false, "error": "等待页面返回超时，页面可能还没加载或表达式没有结束" }));
    pending().lock().unwrap().remove(&id);
    result
}

#[tauri::command]
pub fn debug_reply(reply: Value) {
    let id = reply["id"].as_str().unwrap_or_default().to_string();
    if let Some(send) = pending().lock().unwrap().remove(&id) {
        let _ = send.send(reply);
    }
}

/// 模拟 Syncthing 的某个状态（starting / occupied / failed / stopped / error），传空恢复真实状态
#[tauri::command]
pub fn debug_simulate(app: AppHandle, state: Option<String>) {
    let monitor = &app.state::<AppState>().syncthing;
    *monitor.simulate.lock().unwrap() = state.filter(|s| !s.is_empty());
    monitor.refresh();
}
