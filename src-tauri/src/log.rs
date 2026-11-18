//! 诊断日志：写文件和轮转交给官方 tauri-plugin-log，这里只做两件事：
//! 写入前脱敏，以及把每条日志统一成一行 JSON（time / level / source / event / detail）
use serde_json::{json, Map, Value};
use std::{path::PathBuf, sync::OnceLock};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

const NAME: &str = if cfg!(debug_assertions) { "fox-sync-dev" } else { "fox-sync" };
/// 我们自己的结构化日志走这个 target，其余是依赖库的日志
const TARGET: &str = "fox_sync::diag";
const MAX_DETAIL: usize = 32 * 1024;

static DIR: OnceLock<PathBuf> = OnceLock::new();

/// 单文件 5 MB，保留最近 5 份（旧文件按日期改名）；依赖库只记 warn 以上
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(TargetKind::LogDir { file_name: Some(NAME.into()) }))
        .max_file_size(5 * 1024 * 1024)
        .rotation_strategy(RotationStrategy::KeepSome(5))
        .timezone_strategy(TimezoneStrategy::UseUtc)
        .level(::log::LevelFilter::Warn)
        .level_for("fox_sync", ::log::LevelFilter::Info)
        .format(|out, message, record| {
            let head = json!({
                "time": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                "level": record.level().as_str().to_lowercase(),
            })
            .to_string();
            let body = if record.target() == TARGET {
                message.to_string()
            } else {
                json!({ "source": record.target(), "event": "log", "detail": { "text": redact_text(&message.to_string()) } }).to_string()
            };
            // 两个对象拼成一个：去掉 head 的右括号和 body 的左括号
            out.finish(format_args!("{},{}", &head[..head.len() - 1], &body[1..]))
        })
        .build()
}

/// 记下日志目录给「打开调试日志」和「清除数据」用，并把 panic 也写进日志
pub fn init(dir: PathBuf) {
    let _ = DIR.set(dir);
    std::panic::set_hook(Box::new(|info| {
        error("main", "panic", json!({ "message": info.to_string() }));
    }));
}

pub fn dir() -> Option<PathBuf> {
    DIR.get().cloned()
}

pub fn info(source: &str, event: &str, detail: Value) {
    write("info", source, event, detail)
}
pub fn warn(source: &str, event: &str, detail: Value) {
    write("warn", source, event, detail)
}
pub fn error(source: &str, event: &str, detail: Value) {
    write("error", source, event, detail)
}

pub fn write(level: &str, source: &str, event: &str, detail: Value) {
    let level = match level {
        "info" => ::log::Level::Info,
        "warn" => ::log::Level::Warn,
        _ => ::log::Level::Error,
    };
    let mut entry = json!({
        "source": truncate(&redact_text(source), 80),
        "event": truncate(&redact_text(event), 120),
        "detail": redact(detail),
    });
    if entry.to_string().len() > MAX_DETAIL {
        entry["detail"] = json!({ "truncated": true });
    }
    ::log::log!(target: TARGET, level, "{entry}");
}

fn truncate(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

// 键名命中这些词的值整体隐去：令牌、密钥和消息正文都不进日志
const SECRET_KEYS: [&str; 9] = [
    "token", "secret", "key", "password", "authorization", "body", "message", "title", "text",
];

pub fn redact(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                let lower = k.to_lowercase();
                // message_id 这类标识保留
                let secret = SECRET_KEYS.iter().any(|s| lower.contains(s))
                    && !lower.ends_with("id")
                    && !lower.ends_with("count")
                    && !lower.ends_with("set");
                out.insert(k, if secret { json!("[redacted]") } else { redact(v) });
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(redact).collect()),
        Value::String(s) => Value::String(redact_text(&truncate(&s, 2000))),
        other => other,
    }
}

// ntfy 访问令牌形如 tk_ 加 29 位字母数字，出现在任意字符串里都替换；Bearer 后面的值也替换
pub fn redact_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if text[i..].starts_with("tk_") {
            let rest = &bytes[i + 3..];
            let n = rest.iter().take_while(|b| b.is_ascii_alphanumeric()).count();
            if n >= 16 {
                out.push_str("tk_***");
                i += 3 + n;
                continue;
            }
        }
        if bytes.len() >= i + 7 && bytes[i..i + 7].eq_ignore_ascii_case(b"bearer ") {
            out.push_str("Bearer ***");
            i += 7;
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            continue;
        }
        let ch = text[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redacts_tokens_and_content() {
        let v = redact(json!({
            "token": "tk_abc",
            "messageId": "m1",
            "detail": { "body": "hello", "url": "https://x/?auth=tk_0123456789abcdefghijklmnopqrs" },
            "header": "Bearer tk_secret",
        }));
        assert_eq!(v["token"], "[redacted]");
        assert_eq!(v["messageId"], "m1");
        assert_eq!(v["detail"]["body"], "[redacted]");
        assert_eq!(v["detail"]["url"], "https://x/?auth=tk_***");
        assert_eq!(v["header"], "Bearer ***");
    }
    #[test]
    fn keeps_plain_text() {
        assert_eq!(redact_text("连接成功 tk_ok"), "连接成功 tk_ok");
    }
}
