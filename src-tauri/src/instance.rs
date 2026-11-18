//! 开发版和安装版互顶：两者共用同一个包身份，单实例插件会让后启动的那个直接退出（只唤出已开的窗口）
//! 这里在插件之前先看一眼：另一个构建（程序路径不同）在跑，就让它退出，后启动的接管；
//! 同一个构建重复打开仍交给单实例插件
use crate::log;
use serde_json::json;
use std::{fs, path::PathBuf, process::Command, thread, time::Duration};

// 和单实例插件的 socket 放在一起，启动早期还拿不到应用数据目录
const FILE: &str = "/tmp/com_tobe_fox_sync_instance";

fn me() -> String {
    std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default()
}

/// 进程还在、并且确实是记录里的那个程序（防止 PID 被别的进程复用）
fn running(pid: u32, exe: &str) -> bool {
    Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim() == exe)
        .unwrap_or(false)
}

/// 返回被顶掉的那个程序路径，写日志用
pub fn take_over() -> Option<String> {
    let text = fs::read_to_string(FILE).ok()?;
    let (pid, exe) = text.trim().split_once(' ')?;
    let pid: u32 = pid.parse().ok()?;
    let me = me();
    if pid == std::process::id() || exe == me || !running(pid, exe) {
        return None;
    }
    let _ = Command::new("kill").args(["-TERM", &pid.to_string()]).status();
    for _ in 0..50 {
        if !running(pid, exe) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    Some(exe.to_string())
}

/// 确认自己是唯一实例后记下 PID 和程序路径
pub fn claim() {
    if let Err(e) = fs::write(PathBuf::from(FILE), format!("{} {}", std::process::id(), me())) {
        log::warn("main", "instance-claim-failed", json!({ "reason": e.to_string() }));
    }
}
