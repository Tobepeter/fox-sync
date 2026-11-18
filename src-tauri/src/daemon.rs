//! 内置 Syncthing 的进程管理：启动前识别谁占着配置目录，自己拉起并看护子进程，退出时让它正常关闭
//! 同一个配置目录同时只能跑一个 Syncthing（锁文件），所以绝不在别人占着的时候再起一个
use crate::{log, AppState};
use serde::Serialize;
use serde_json::json;
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

const LOG_LINES: usize = 200;
/// 5 分钟内意外退出超过这么多次就不再拉起，等用户处理
const MAX_CRASHES: usize = 5;
const APP_BUNDLE_ID: &str = "com.github.xor-gate.syncthing-macosx";

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Occupant {
    /// own：FoxSync 自己上次留下的；app：Syncthing.app；brew：brew 后台服务；other：认不出的
    pub kind: String,
    pub pid: u32,
    pub path: String,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct DaemonStatus {
    /// idle：还没开始；starting；running；occupied：别人占着；failed：起不来；nobinary：开发时没准备内置二进制
    pub state: String,
    pub occupant: Option<Occupant>,
    pub error: String,
    /// 起不来时最近几行输出，界面上展示
    pub tail: Vec<String>,
}

#[derive(Default)]
pub struct Daemon {
    pub status: Mutex<DaemonStatus>,
    pid: Mutex<Option<u32>>,
    /// 本次运行生成的 API key，启动时经环境变量 STGUIAPIKEY 交给 Syncthing，不写盘
    key: Mutex<String>,
    stopping: AtomicBool,
    crashes: Mutex<VecDeque<Instant>>,
    output: Mutex<VecDeque<String>>,
}

impl Daemon {
    /// 自己运行着 Syncthing 时返回本次的 API key
    pub fn key(&self) -> Option<String> {
        let running = self.status.lock().unwrap().state == "running" || self.pid.lock().unwrap().is_some();
        let key = self.key.lock().unwrap().clone();
        (running && !key.is_empty()).then_some(key)
    }
    fn set(&self, update: impl FnOnce(&mut DaemonStatus)) {
        update(&mut self.status.lock().unwrap());
    }
}

/// 沙盒测试：FOX_SYNC_ST_HOME 指定另一个配置目录，FOX_SYNC_ST_GUI 指定另一个管理地址，不碰真实配置
pub fn sandbox_home() -> Option<PathBuf> {
    std::env::var_os("FOX_SYNC_ST_HOME").map(PathBuf::from)
}
pub fn sandbox_gui() -> Option<String> {
    std::env::var("FOX_SYNC_ST_GUI").ok().filter(|s| !s.is_empty())
}

/// 内置二进制：打包后在 Contents/MacOS/syncthing，开发时 tauri 拷到 target/debug/syncthing
fn binary() -> Option<PathBuf> {
    let path = std::env::current_exe().ok()?.parent()?.join("syncthing");
    path.exists().then_some(path)
}

fn is_own(path: &str) -> bool {
    path.contains("FoxSync.app/") || path.contains("/fox-sync/src-tauri/target/")
}

/// 从 ps 输出里找 syncthing 进程，只看最外层（父进程不是 syncthing 的那个），按路径和父进程判断是谁
pub fn find_occupant() -> Option<Occupant> {
    let out = Command::new("/bin/ps").args(["-axo", "pid=,ppid=,command="]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let rows: Vec<(u32, u32, String)> = text
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let pid = it.next()?.parse().ok()?;
            let ppid = it.next()?.parse().ok()?;
            Some((pid, ppid, it.collect::<Vec<_>>().join(" ")))
        })
        .collect();
    let home = sandbox_home().map(|h| h.to_string_lossy().into_owned());
    classify(&rows, std::process::id(), home.as_deref())
}

/// 和这次用的是不是同一个配置目录。`home` 为 None 表示默认目录（不是沙盒）
/// 命令行没写 `--home` 的就是默认目录；写了的话看路径里有没有这次用的目录。ps 输出不带引号，
/// 路径里有空格时没法可靠切开，所以按包含判断
fn same_home(command: &str, home: Option<&str>) -> bool {
    let flagged = command.split_whitespace().any(|a| a == "--home" || a == "-home" || a.starts_with("--home=") || a.starts_with("-home="));
    match home {
        None => !flagged,
        Some(h) => flagged && command.contains(h.trim_end_matches('/')),
    }
}

fn exe_of(command: &str) -> &str {
    command.split_whitespace().next().unwrap_or("")
}

/// `home` 是这次用的沙盒配置目录，None 是默认目录；用别的配置目录的 Syncthing 不抢同一把锁，不算占用。
/// 沙盒模式下 Syncthing.app 用的是默认目录，不能当成占用者去接管（2026-11-16 实测踩到）
pub fn classify(rows: &[(u32, u32, String)], me: u32, home: Option<&str>) -> Option<Occupant> {
    let is_syncthing = |cmd: &str| {
        let exe = exe_of(cmd);
        (exe == "syncthing" || exe.ends_with("/syncthing"))
            && !cmd.contains(" cli ")
            && !cmd.contains("--version")
            && same_home(cmd, home)
    };
    let parent = |ppid: u32| rows.iter().find(|r| r.0 == ppid);
    let (pid, ppid, cmd) = rows.iter().find(|(_, ppid, cmd)| {
        is_syncthing(cmd) && !parent(*ppid).is_some_and(|p| is_syncthing(&p.2))
    })?;
    let path = exe_of(cmd).to_string();
    let parent_cmd = parent(*ppid).map(|p| p.2.as_str()).unwrap_or("");
    // Syncthing.app 可以设成调用别处的 syncthing（比如 brew 装的），启动后父进程是 1、命令行也不带路径，
    // 光看进程认不出；只要 Syncthing.app 在跑就得先退出它，不然它会把 Syncthing 再拉起来（2026-11-18 m3 上实测）
    let app_running = rows.iter().any(|r| exe_of(&r.2).ends_with("Syncthing.app/Contents/MacOS/Syncthing"));
    let kind = if is_own(&path) {
        // 自己这次拉起的不算占用
        if *ppid == me {
            return None;
        }
        "own"
    } else if app_running || parent_cmd.contains("Syncthing.app/Contents/MacOS") || path.contains("Syncthing.app/") {
        "app"
    } else if path.starts_with("/opt/homebrew/") || path.starts_with("/usr/local/") {
        "brew"
    } else {
        "other"
    };
    Some(Occupant { kind: kind.into(), pid: *pid, path })
}

fn alive(pid: u32) -> bool {
    Command::new("/bin/kill").args(["-0", &pid.to_string()]).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

/// 等到没有任何占用同一配置目录的 Syncthing；超时返回还在的那个
fn wait_free(timeout: Duration) -> Option<Occupant> {
    let started = Instant::now();
    loop {
        let o = find_occupant()?;
        if started.elapsed() >= timeout {
            return Some(o);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn wait_gone(pid: u32, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if !alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    !alive(pid)
}

/// 结束 FoxSync 上次没收拾好留下的 Syncthing。v2 是看护进程带一个干活的进程，外层先退、里层还占着锁，
/// 所以要一直等到认不出任何残留为止
fn clear_orphans() {
    let started = Instant::now();
    while let Some(o) = find_occupant().filter(|o| o.kind == "own") {
        if started.elapsed() > Duration::from_secs(15) {
            log::warn("daemon", "orphan-stuck", json!({ "pid": o.pid }));
            return;
        }
        log::info("daemon", "orphan", json!({ "pid": o.pid }));
        terminate(o.pid);
        wait_gone(o.pid, Duration::from_secs(10));
    }
}

fn terminate(pid: u32) {
    let _ = Command::new("/bin/kill").args(["-TERM", &pid.to_string()]).status();
}

/// 启动时调用：看有没有人占着，没人就自己拉起
pub fn ensure(app: &AppHandle) {
    let daemon = &app.state::<AppState>().daemon;
    daemon.set(|s| {
        s.occupant = None;
        s.error.clear();
        s.tail.clear();
    });
    if binary().is_none() {
        daemon.set(|s| s.state = "nobinary".into());
        log::warn("daemon", "no-binary", json!({}));
        return;
    }
    // 只认用同一个配置目录的：沙盒时不管系统里的 Syncthing.app，只收拾同一个沙盒目录的残留
    if let Some(o) = find_occupant() {
        if o.kind == "own" {
            clear_orphans();
        } else {
            log::info("daemon", "occupied", json!({ "kind": o.kind, "pid": o.pid }));
            daemon.set(|s| {
                s.state = "occupied".into();
                s.occupant = Some(o);
            });
            return;
        }
    }
    spawn(app);
}

fn spawn(app: &AppHandle) {
    let daemon = &app.state::<AppState>().daemon;
    let Some(bin) = binary() else { return };
    let key = uuid::Uuid::new_v4().simple().to_string();
    *daemon.key.lock().unwrap() = key.clone();
    daemon.stopping.store(false, Ordering::SeqCst);
    daemon.set(|s| {
        s.state = "starting".into();
        s.error.clear();
    });
    let mut cmd = Command::new(&bin);
    // key 走环境变量 STGUIAPIKEY，不放命令行参数：参数谁都能用 ps 看到
    cmd.args(["serve", "--no-browser", "--no-restart"])
        .env("STGUIAPIKEY", &key)
        .env("STNOUPGRADE", "1")
        // 新装时不建 Syncthing 自带的 ~/Sync 默认文件夹，文件夹都由 FoxSync 新建或加入
        .env("STNODEFAULTFOLDER", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(home) = sandbox_home() {
        cmd.arg(format!("--home={}", home.display()));
    }
    if let Some(gui) = sandbox_gui() {
        cmd.arg(format!("--gui-address={gui}"));
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            log::error("daemon", "spawn-failed", json!({ "error": e.to_string() }));
            daemon.set(|s| {
                s.state = "failed".into();
                s.error = format!("启动内置 Syncthing 失败：{e}");
            });
            return;
        }
    };
    let pid = child.id();
    *daemon.pid.lock().unwrap() = Some(pid);
    log::info("daemon", "spawned", json!({ "pid": pid, "sandbox": sandbox_home().is_some() }));
    for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>)]
        .into_iter()
        .flatten()
    {
        let handle = app.clone();
        std::thread::spawn(move || {
            let state = handle.state::<AppState>();
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                let mut out = state.daemon.output.lock().unwrap();
                if out.len() >= LOG_LINES {
                    out.pop_front();
                }
                out.push_back(line);
            }
        });
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        on_exit(&handle, pid, code);
    });
}

/// 子进程退出：自己要求停的就结束；0 或 3（Syncthing 请求重启）立刻重启；其他退避后重启，频繁崩溃就停下
fn on_exit(app: &AppHandle, pid: u32, code: Option<i32>) {
    let daemon = &app.state::<AppState>().daemon;
    {
        let mut current = daemon.pid.lock().unwrap();
        if *current == Some(pid) {
            *current = None;
        }
    }
    if daemon.stopping.load(Ordering::SeqCst) {
        log::info("daemon", "stopped", json!({ "pid": pid, "code": code }));
        return;
    }
    let tail: Vec<String> = daemon.output.lock().unwrap().iter().rev().take(20).rev().cloned().collect();
    log::warn("daemon", "exited", json!({ "pid": pid, "code": code }));
    if matches!(code, Some(0) | Some(3)) {
        spawn(app);
        app.state::<AppState>().syncthing.refresh();
        return;
    }
    let crashes = {
        let mut list = daemon.crashes.lock().unwrap();
        list.push_back(Instant::now());
        while list.front().is_some_and(|t| t.elapsed() > Duration::from_secs(300)) {
            list.pop_front();
        }
        list.len()
    };
    // 抢锁失败也是退出码 1：自己的残留就收拾掉马上重来，别人刚好起来了就转成“被占用”
    if find_occupant().is_some_and(|o| o.kind == "own") {
        clear_orphans();
        spawn(app);
        return;
    }
    // 别人的实例可能正在退出（比如刚接管、Syncthing.app 的里层进程还没退完），等几秒再判
    if find_occupant().is_some_and(|o| o.kind != "own") && wait_free(Duration::from_secs(5)).is_none() {
        spawn(app);
        return;
    }
    if let Some(o) = find_occupant().filter(|o| o.kind != "own") {
        daemon.set(|s| {
            s.state = "occupied".into();
            s.occupant = Some(o);
        });
        app.state::<AppState>().syncthing.refresh();
        return;
    }
    if crashes > MAX_CRASHES {
        daemon.set(|s| {
            s.state = "failed".into();
            s.error = format!("内置 Syncthing 反复退出（退出码 {}）", code.map(|c| c.to_string()).unwrap_or("无".into()));
            s.tail = tail;
        });
        app.state::<AppState>().syncthing.refresh();
        return;
    }
    let delay = Duration::from_secs(2u64.pow(crashes as u32).min(60));
    daemon.set(|s| s.state = "starting".into());
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        if !handle.state::<AppState>().daemon.stopping.load(Ordering::SeqCst) {
            spawn(&handle);
            handle.state::<AppState>().syncthing.refresh();
        }
    });
}

/// 用户同意接管：让占用者的看护那一层先停，再让进程自己退出，最后才发 SIGTERM，然后拉起内置的
pub async fn take_over(app: &AppHandle) -> Result<(), String> {
    let Some(o) = find_occupant() else {
        spawn(app);
        return Ok(());
    };
    log::info("daemon", "take-over", json!({ "kind": o.kind, "pid": o.pid }));
    match o.kind.as_str() {
        "app" => {
            let _ = Command::new("/usr/bin/osascript")
                .args(["-e", &format!("tell application id \"{APP_BUNDLE_ID}\" to quit")])
                .status();
        }
        "brew" => {
            let brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].into_iter().find(|p| std::path::Path::new(p).exists());
            if let Some(brew) = brew {
                let _ = Command::new(brew).args(["services", "stop", "syncthing"]).status();
            }
        }
        "other" => return Err(format!("占用的是 {}，FoxSync 认不出是谁启动的，请先手动关掉它", o.path)),
        _ => {}
    }
    // 要等所有占用者都退干净：v2 是看护进程带一个干活的进程，外层先退、里层还占着锁，
    // 只等外层就去拉起会抢锁失败（2026-11-17 实测踩到：接管后两边都没在跑）
    let mut left = wait_free(Duration::from_secs(10));
    if left.is_some() {
        // 看护层停了进程还在：让它自己关，再不行才 SIGTERM
        let _ = crate::syncthing::shutdown_external(app).await;
        left = wait_free(Duration::from_secs(10));
    }
    if let Some(o) = left {
        terminate(o.pid);
        if let Some(o) = wait_free(Duration::from_secs(10)) {
            return Err(format!("占用的 Syncthing 没有退出，请手动关掉它：{}", o.path));
        }
    }
    app.state::<AppState>().daemon.crashes.lock().unwrap().clear();
    spawn(app);
    Ok(())
}

/// 重新拉起（起不来之后用户点重试）
pub fn restart(app: &AppHandle) {
    let daemon = &app.state::<AppState>().daemon;
    daemon.crashes.lock().unwrap().clear();
    stop(app);
    ensure(app);
}

/// 退出 FoxSync 或切到 external 时：先请求 Syncthing 自己关闭，等不到再 SIGTERM，最后 SIGKILL
pub fn stop(app: &AppHandle) {
    let daemon = &app.state::<AppState>().daemon;
    daemon.stopping.store(true, Ordering::SeqCst);
    let Some(pid) = *daemon.pid.lock().unwrap() else { return };
    let handle = app.clone();
    let asked = tauri::async_runtime::block_on(async move { crate::syncthing::shutdown_own(&handle).await.is_ok() });
    if !(asked && wait_gone(pid, Duration::from_secs(8))) {
        terminate(pid);
        if !wait_gone(pid, Duration::from_secs(5)) {
            let _ = Command::new("/bin/kill").args(["-KILL", &pid.to_string()]).status();
        }
    }
    log::info("daemon", "stop", json!({ "pid": pid, "graceful": asked }));
    daemon.set(|s| s.state = "idle".into());
}

/// 每轮状态刷新时带上最新的输出尾巴
pub fn snapshot(app: &AppHandle) -> DaemonStatus {
    app.state::<AppState>().daemon.status.lock().unwrap().clone()
}

/// Syncthing 已经能响应时标成 running
pub fn mark_running(app: &AppHandle) {
    let daemon = &app.state::<AppState>().daemon;
    let mut s = daemon.status.lock().unwrap();
    if s.state == "starting" && daemon.pid.lock().unwrap().is_some() {
        s.state = "running".into();
        log::info("daemon", "running", json!({}));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(pid: u32, ppid: u32, cmd: &str) -> (u32, u32, String) {
        (pid, ppid, cmd.to_string())
    }
    #[test]
    fn finds_syncthing_app() {
        let rows = vec![
            row(10, 1, "/Applications/Syncthing.app/Contents/MacOS/Syncthing"),
            row(11, 10, "/Applications/Syncthing.app/Contents/Resources/syncthing/syncthing --no-browser --no-restart"),
            row(12, 11, "/Applications/Syncthing.app/Contents/Resources/syncthing/syncthing --no-browser --no-restart"),
        ];
        let o = classify(&rows, 999, HOME).unwrap();
        assert_eq!((o.kind.as_str(), o.pid), ("app", 11));
        // Syncthing.app 设成用 brew 装的：命令行不带路径，父进程是 1
        let brew_binary = vec![
            row(10, 1, "/Applications/Syncthing.app/Contents/MacOS/Syncthing"),
            row(20, 1, "syncthing serve --no-browser --log-file=/Users/x/Library/Application Support/Syncthing/syncthing.log"),
            row(21, 20, "/opt/homebrew/bin/syncthing serve --no-browser"),
        ];
        let o = classify(&brew_binary, 999, HOME).unwrap();
        assert_eq!((o.kind.as_str(), o.pid), ("app", 20));
    }
    #[test]
    fn finds_brew_and_own_and_other() {
        let brew = vec![row(20, 1, "/opt/homebrew/opt/syncthing/bin/syncthing serve --no-browser")];
        assert_eq!(classify(&brew, 999, HOME).unwrap().kind, "brew");
        let own = vec![row(30, 5, "/Applications/FoxSync.app/Contents/MacOS/syncthing serve --no-browser")];
        assert_eq!(classify(&own, 999, HOME).unwrap().kind, "own");
        // 自己这次拉起的不算占用
        assert_eq!(classify(&own, 5, HOME), None);
        let other = vec![row(40, 2, "/Users/x/bin/syncthing")];
        assert_eq!(classify(&other, 999, HOME).unwrap().kind, "other");
    }
    const HOME: Option<&str> = None;
    #[test]
    fn ignores_other_config_dirs() {
        // 默认目录时，用别的 --home 跑的不算占用
        let sandboxes = vec![
            row(60, 1, "/Users/x/fox-sync/src-tauri/target/debug/syncthing serve --home=/tmp/sandbox/a"),
            row(61, 1, "/opt/homebrew/bin/syncthing serve --home /tmp/sandbox/b"),
        ];
        assert_eq!(classify(&sandboxes, 999, HOME), None);
        // 沙盒时，Syncthing.app 用的默认目录不算占用，同一个沙盒目录的残留才算
        let app = vec![
            row(10, 1, "/Applications/Syncthing.app/Contents/MacOS/Syncthing"),
            row(11, 10, "/Applications/Syncthing.app/Contents/Resources/syncthing/syncthing --no-browser --no-restart"),
        ];
        assert_eq!(classify(&app, 999, Some("/tmp/sandbox/a")), None);
        let orphan = vec![row(60, 1, "/Users/x/fox-sync/src-tauri/target/debug/syncthing serve --home=/tmp/sandbox/a")];
        assert_eq!(classify(&orphan, 999, Some("/tmp/sandbox/a/")).unwrap().kind, "own");
        assert_eq!(classify(&orphan, 999, Some("/tmp/sandbox/b")), None);
    }
    #[test]
    fn ignores_cli_and_unrelated() {
        let rows = vec![
            row(50, 1, "/opt/homebrew/bin/syncthing cli show system"),
            row(51, 1, "/usr/bin/grep syncthing"),
            row(52, 1, "/Applications/Syncthing.app/Contents/MacOS/Syncthing"),
        ];
        assert_eq!(classify(&rows, 999, HOME), None);
    }
}
