//! FoxSync 自己运行的 Syncthing：拉取设备和文件夹状态，挂在事件流上等变化
//! API key 每次启动随机生成，只在 Rust 侧使用，不发给前端、不进日志
use crate::{
    daemon::{self, DaemonStatus},
    log, AppState,
};
use reqwest::{Client, Method, StatusCode};
use serde::Serialize;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

const DEFAULT_URL: &str = "http://127.0.0.1:8384";
const POLL: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Syncthing {
    /// checking：还没查过；starting：正在启动；occupied：别的 Syncthing 占着配置目录，等用户选接管；
    /// failed：起不来；stopped：进程在但连不上；error：其他错误；ok：正常
    pub state: String,
    pub error: String,
    pub url: String,
    pub version: String,
    pub my_id: String,
    pub devices: Vec<Device>,
    pub folders: Vec<Folder>,
    /// 别的设备共享过来、本机还没加入的文件夹
    pub pending_folders: Vec<PendingFolder>,
    /// 想连本机、但还不在本机设备表里的设备
    pub pending_devices: Vec<PendingDevice>,
    /// 在“可加入”里忽略过的邀请，记在各设备的 ignoredFolders 里
    pub ignored_folders: Vec<IgnoredFolder>,
    /// 在“请求连接”里忽略过的设备，记在配置的 remoteIgnoredDevices 里
    pub ignored_devices: Vec<PendingDevice>,
    /// 内置 Syncthing 的进程状态
    pub daemon: DaemonStatus,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Device {
    pub id: String,
    /// 本机配置里给这台设备起的名字
    pub name: String,
    pub me: bool,
    pub connected: bool,
    pub paused: bool,
    /// 连接方式，如 tcp-client、quic-server、relay-client
    pub kind: String,
    /// 对方地址，Syncthing 给的是 `192.168.1.2:22000`、`[fe80::1%en0]:22000` 这种，不带协议前缀
    pub address: String,
    /// Syncthing 判定的局域网连接（`isLocal`）；之前按地址前缀猜，格式对不上，局域网一次都没认出来（2026-11-18）
    pub local: bool,
    pub client_version: String,
    /// 最后在线时间，RFC 3339
    pub last_seen: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Folder {
    pub id: String,
    pub label: String,
    pub path: String,
    /// sendreceive、sendonly、receiveonly、receiveencrypted
    pub kind: String,
    pub paused: bool,
    /// idle、scanning、syncing、error 等，取自 Syncthing；拿不到时为空
    pub state: String,
    pub error: String,
    /// 共享给了哪些设备（不含本机）
    pub devices: Vec<String>,
    pub global_bytes: u64,
    pub global_items: u64,
    pub local_bytes: u64,
    pub need_bytes: u64,
    pub need_items: u64,
    /// 出错的文件数
    pub error_items: u64,
    /// 仅接收的文件夹里本机改过、没发出去的条目数
    pub local_changes: u64,
    /// 回收站式版本保留开着
    pub versioning: bool,
    /// 冲突副本（.sync-conflict-）个数，后台定时数
    pub conflicts: u32,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct PendingFolder {
    pub id: String,
    /// 对方填的显示名，几台设备都共享时取最早的那条
    pub label: String,
    /// 哪些设备共享了它
    pub offered_by: Vec<String>,
    /// 最早收到的时间，RFC 3339
    pub time: String,
    /// 本机已经有这个文件夹，只是没共享给对方（比如移除设备时共享跟着没了）：要做的是共享给它，不是加入
    pub existing: bool,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct PendingDevice {
    pub id: String,
    /// 对方自报的设备名
    pub name: String,
    pub address: String,
    pub time: String,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct IgnoredFolder {
    pub id: String,
    pub label: String,
    /// 哪台设备的邀请被忽略了
    pub device: String,
    pub time: String,
}

/// 设备表里每台设备的 ignoredFolders 摊平，新的在前
pub fn parse_ignored(devices: &Value) -> Vec<IgnoredFolder> {
    let mut out: Vec<IgnoredFolder> = devices
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|d| {
            let device = text(d, "deviceID");
            d["ignoredFolders"].as_array().cloned().unwrap_or_default().into_iter().map(move |f| IgnoredFolder {
                id: text(&f, "id"),
                label: text(&f, "label"),
                device: device.clone(),
                time: text(&f, "time"),
            })
        })
        .collect();
    out.sort_by(|a, b| b.time.cmp(&a.time));
    out
}

/// `GET /rest/cluster/pending/folders`：{文件夹 ID: {offeredBy: {设备 ID: {time, label, …}}}}
pub fn parse_pending_folders(v: &Value) -> Vec<PendingFolder> {
    let mut out: Vec<PendingFolder> = v
        .as_object()
        .into_iter()
        .flatten()
        .map(|(id, f)| {
            let mut offers: Vec<(&String, &Value)> = f["offeredBy"].as_object().into_iter().flatten().collect();
            offers.sort_by(|a, b| text(a.1, "time").cmp(&text(b.1, "time")));
            let first = offers.first().map(|o| o.1).unwrap_or(&Value::Null);
            PendingFolder {
                id: id.clone(),
                label: text(first, "label"),
                time: text(first, "time"),
                offered_by: offers.iter().map(|o| o.0.clone()).collect(),
                existing: false,
            }
        })
        .collect();
    out.sort_by(|a, b| b.time.cmp(&a.time));
    out
}

/// `GET /rest/cluster/pending/devices`：{设备 ID: {time, name, address}}
pub fn parse_pending_devices(v: &Value) -> Vec<PendingDevice> {
    let mut out: Vec<PendingDevice> = v
        .as_object()
        .into_iter()
        .flatten()
        .map(|(id, d)| PendingDevice { id: id.clone(), name: text(d, "name"), address: text(d, "address"), time: text(d, "time") })
        .collect();
    out.sort_by(|a, b| b.time.cmp(&a.time));
    out
}

#[derive(Default)]
pub struct Monitor {
    pub status: Mutex<Syncthing>,
    /// 文件夹 ID → 冲突副本的相对路径，后台定时遍历目录得到
    pub conflicts: Mutex<std::collections::HashMap<String, Vec<String>>>,
    wake: Notify,
    /// DEV 调试：模拟某个状态看界面，空表示不模拟
    pub simulate: Mutex<Option<String>>,
}

impl Monitor {
    pub fn refresh(&self) {
        self.wake.notify_one();
    }
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

/// Syncthing 配置文件，STHOMEDIR 优先
pub fn config_path() -> PathBuf {
    if let Some(dir) = daemon::sandbox_home() {
        return dir.join("config.xml");
    }
    if let Some(dir) = std::env::var_os("STHOMEDIR") {
        return PathBuf::from(dir).join("config.xml");
    }
    home().join("Library/Application Support/Syncthing/config.xml")
}

/// 从 config.xml 的 <gui> 段取管理地址和 API key；只做简单的文本查找，不引入 XML 库
pub fn parse_gui(xml: &str) -> (Option<String>, Option<String>) {
    let Some(start) = xml.find("<gui") else { return (None, None) };
    let end = xml[start..].find("</gui>").map(|e| start + e).unwrap_or(xml.len());
    let gui = &xml[start..end];
    let tag = |name: &str| {
        let open = format!("<{name}>");
        let close = format!("</{name}>");
        let a = gui.find(&open)? + open.len();
        let b = gui[a..].find(&close)? + a;
        Some(gui[a..b].trim().to_string()).filter(|v| !v.is_empty())
    };
    let tls = gui.split('>').next().is_some_and(|head| head.contains("tls=\"true\""));
    let url = tag("address").map(|addr| {
        let addr = addr.replace("0.0.0.0", "127.0.0.1");
        format!("{}://{addr}", if tls { "https" } else { "http" })
    });
    (url, tag("apikey"))
}

pub(crate) struct Target {
    pub url: String,
    pub key: Option<String>,
}

/// 地址从配置文件的 <gui> 读（沙盒时用沙盒地址）；key 用本次启动时交给 Syncthing 的，
/// 还没拉起时退回配置文件里的（接管时让别人的实例关闭要用）
pub(crate) fn target(app: &AppHandle) -> Target {
    let (url, key) = std::fs::read_to_string(config_path())
        .map(|xml| parse_gui(&xml))
        .unwrap_or((None, None));
    let url = daemon::sandbox_gui().map(|g| format!("http://{g}")).or(url);
    Target {
        url: url.unwrap_or_else(|| DEFAULT_URL.into()),
        key: app.state::<AppState>().daemon.key().or(key),
    }
}

pub(crate) fn client() -> Client {
    // 本机管理页开了 HTTPS 时是自签证书；只连本机，接受自签
    Client::builder()
        .timeout(Duration::from_secs(5))
        .danger_accept_invalid_certs(true)
        .no_proxy()
        .build()
        .unwrap_or_default()
}

pub(crate) enum Failure {
    Unreachable(String),
    Unauthorized,
    Other(String),
}

pub(crate) async fn request(client: &Client, t: &Target, method: Method, path: &str, body: Option<Value>) -> Result<Value, Failure> {
    let mut req = client.request(method, format!("{}{path}", t.url));
    if let Some(key) = &t.key {
        req = req.header("X-API-Key", key);
    }
    if let Some(body) = body {
        req = req.json(&body);
    }
    let res = req.send().await.map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            Failure::Unreachable(e.to_string())
        } else {
            Failure::Other(e.to_string())
        }
    })?;
    match res.status() {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(Failure::Unauthorized),
        s if !s.is_success() => Err(Failure::Other(format!("{path} 返回 {s}"))),
        _ => {
            let text = res.text().await.map_err(|e| Failure::Other(e.to_string()))?;
            Ok(if text.trim().is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::Null) })
        }
    }
}

pub(crate) async fn get(client: &Client, t: &Target, path: &str) -> Result<Value, Failure> {
    request(client, t, Method::GET, path, None).await
}

pub(crate) fn text(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or_default().to_string()
}

/// 先看内置进程的状态：别人占着、起不来时不去连；正在启动时连不上算“启动中”
async fn fetch(app: &AppHandle) -> Syncthing {
    let d = daemon::snapshot(app);
    let base = || Syncthing { url: target(app).url, daemon: d.clone(), ..Default::default() };
    match d.state.as_str() {
        "occupied" => return Syncthing { state: "occupied".into(), ..base() },
        // 还在识别占用，先不去连，免得把别人的实例当成自己的闪一下
        "checking" => return Syncthing { state: "checking".into(), ..base() },
        "failed" => return Syncthing { state: "failed".into(), error: d.error.clone(), ..base() },
        _ => {}
    }
    let mut s = fetch_api(app).await;
    s.daemon = d.clone();
    if d.state == "starting" {
        if s.state == "ok" {
            daemon::mark_running(app);
            s.daemon = daemon::snapshot(app);
        } else if s.state == "stopped" {
            s.state = "starting".into();
            s.error.clear();
        }
    }
    s
}

async fn fetch_api(app: &AppHandle) -> Syncthing {
    let t = target(app);
    let base = Syncthing { url: t.url.clone(), ..Default::default() };
    let client = client();
    let failed = |f: Failure, base: Syncthing| match f {
        Failure::Unreachable(e) => Syncthing { state: "stopped".into(), error: e, ..base },
        Failure::Unauthorized => Syncthing { state: "error".into(), error: "Syncthing 拒绝了请求".into(), ..base },
        Failure::Other(e) => Syncthing { state: "error".into(), error: e, ..base },
    };
    let status = match get(&client, &t, "/rest/system/status").await {
        Ok(v) => v,
        Err(f) => return failed(f, base),
    };
    let my_id = text(&status, "myID");
    let (version, config, connections, stats, pending_folders, pending_devices) = tokio::join!(
        get(&client, &t, "/rest/system/version"),
        get(&client, &t, "/rest/config"),
        get(&client, &t, "/rest/system/connections"),
        get(&client, &t, "/rest/stats/device"),
        get(&client, &t, "/rest/cluster/pending/folders"),
        get(&client, &t, "/rest/cluster/pending/devices"),
    );
    let config = match config {
        Ok(v) => v,
        Err(f) => return failed(f, base),
    };
    let connections = connections.unwrap_or(Value::Null);
    let stats = stats.unwrap_or(Value::Null);
    let devices = config["devices"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|d| {
            let id = text(d, "deviceID");
            let c = &connections["connections"][&id];
            Device {
                me: id == my_id,
                name: text(d, "name"),
                connected: c["connected"].as_bool().unwrap_or(false),
                paused: d["paused"].as_bool().unwrap_or(false),
                kind: text(c, "type"),
                address: text(c, "address"),
                local: c["isLocal"].as_bool().unwrap_or(false),
                client_version: text(c, "clientVersion"),
                last_seen: stats[&id]["lastSeen"].as_str().map(String::from),
                id,
            }
        })
        .collect();
    let mut folders = vec![];
    for f in config["folders"].as_array().cloned().unwrap_or_default() {
        let id = text(&f, "id");
        let paused = f["paused"].as_bool().unwrap_or(false);
        let db = if paused {
            Value::Null
        } else {
            get(&client, &t, &format!("/rest/db/status?folder={}", urlencode(&id))).await.unwrap_or(Value::Null)
        };
        folders.push(Folder {
            label: text(&f, "label"),
            path: text(&f, "path"),
            kind: text(&f, "type"),
            paused,
            state: if paused { "paused".into() } else { text(&db, "state") },
            error: text(&db, "error"),
            devices: f["devices"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|d| text(d, "deviceID"))
                .filter(|d| *d != my_id)
                .collect(),
            global_bytes: db["globalBytes"].as_u64().unwrap_or(0),
            global_items: db["globalFiles"].as_u64().unwrap_or(0) + db["globalDirectories"].as_u64().unwrap_or(0),
            local_bytes: db["localBytes"].as_u64().unwrap_or(0),
            need_bytes: db["needBytes"].as_u64().unwrap_or(0),
            need_items: db["needTotalItems"].as_u64().unwrap_or(0),
            error_items: db["pullErrors"].as_u64().or(db["errors"].as_u64()).unwrap_or(0),
            local_changes: db["receiveOnlyTotalItems"].as_u64().unwrap_or(0),
            versioning: !text(&f["versioning"], "type").is_empty(),
            conflicts: app.state::<AppState>().syncthing.conflicts.lock().unwrap().get(&id).map(|c| c.len() as u32).unwrap_or(0),
            id,
        });
    }
    let mut pending_folders = pending_folders.map(|v| parse_pending_folders(&v)).unwrap_or_default();
    for p in pending_folders.iter_mut() {
        p.existing = folders.iter().any(|f| f.id == p.id);
    }
    Syncthing {
        state: "ok".into(),
        version: version.map(|v| text(&v, "version")).unwrap_or_default(),
        my_id,
        devices,
        folders,
        pending_folders,
        pending_devices: pending_devices.map(|v| parse_pending_devices(&v)).unwrap_or_default(),
        ignored_folders: parse_ignored(&config["devices"]),
        ignored_devices: {
            let mut list: Vec<PendingDevice> = config["remoteIgnoredDevices"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|d| PendingDevice { id: text(d, "deviceID"), name: text(d, "name"), address: text(d, "address"), time: text(d, "time") })
                .collect();
            list.sort_by(|a, b| b.time.cmp(&a.time));
            list
        },
        ..base
    }
}

pub(crate) fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// DEV 模拟各种异常状态，看界面
fn simulated(state: &str, real: &Syncthing) -> Syncthing {
    Syncthing {
        state: state.into(),
        error: if state == "error" { "模拟错误".into() } else { String::new() },
        url: real.url.clone(),
        daemon: DaemonStatus {
            state: state.into(),
            occupant: (state == "occupied").then(|| daemon::Occupant {
                kind: "app".into(),
                pid: 1,
                path: "/Applications/Syncthing.app/Contents/Resources/syncthing/syncthing".into(),
            }),
            error: if state == "failed" { "内置 Syncthing 反复退出（退出码 1）".into() } else { String::new() },
            tail: if state == "failed" { vec!["模拟输出：Failed to acquire lock".into()] } else { vec![] },
        },
        ..Default::default()
    }
}

/// 界面关心的事件，显式列出（订阅组合在第一次请求时才建，事件 ID 按组合各算各的）
const EVENTS: &str = "StartupComplete,ConfigSaved,StateChanged,FolderSummary,FolderCompletion,FolderErrors,FolderPaused,FolderResumed,DeviceConnected,DeviceDisconnected,DevicePaused,DeviceResumed,PendingDevicesChanged,PendingFoldersChanged";

/// 长轮询事件：返回 true 表示来了相关事件，false 表示等到超时没有事件
async fn wait_events(app: &AppHandle, since: &mut Option<u64>) -> Result<bool, String> {
    let t = target(app);
    let client = Client::builder().timeout(Duration::from_secs(70)).danger_accept_invalid_certs(true).no_proxy().build().map_err(|e| e.to_string())?;
    let fail = |f: Failure| match f {
        Failure::Unreachable(e) | Failure::Other(e) => e,
        Failure::Unauthorized => "unauthorized".into(),
    };
    if since.is_none() {
        // 先拿到最新的事件 ID 当起点；起点之前的状态本轮已经整体拉过
        let v = get(&client, &t, &format!("/rest/events?events={EVENTS}&limit=1&timeout=0")).await.map_err(fail)?;
        *since = Some(v.as_array().and_then(|a| a.last()).and_then(|e| e["id"].as_u64()).unwrap_or(0));
    }
    let from = since.unwrap_or(0);
    let v = get(&client, &t, &format!("/rest/events?events={EVENTS}&since={from}&timeout=55")).await.map_err(fail)?;
    let events = v.as_array().cloned().unwrap_or_default();
    if let Some(last) = events.last().and_then(|e| e["id"].as_u64()) {
        *since = Some(last);
    }
    Ok(!events.is_empty())
}

/// 后台循环：拉一次完整状态，状态变了才通知前端和菜单栏；正常时挂在事件流上等变化，否则定时重试
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_state = String::new();
        let mut since: Option<u64> = None;
        loop {
            let real = fetch(&app).await;
            let monitor = &app.state::<AppState>().syncthing;
            let simulating = monitor.simulate.lock().unwrap().is_some();
            let next = match monitor.simulate.lock().unwrap().clone() {
                Some(s) => simulated(&s, &real),
                None => real,
            };
            if next.state != last_state {
                log::info(
                    "syncthing",
                    "state",
                    json!({ "state": next.state, "from": last_state, "error": next.error, "version": next.version }),
                );
                last_state = next.state.clone();
            }
            let changed = {
                let mut status = monitor.status.lock().unwrap();
                let changed = *status != next;
                *status = next.clone();
                changed
            };
            if changed {
                let _ = app.emit("syncthing", next.clone());
                crate::tray::refresh(&app);
                // Syncthing 起来、设备表变了，都看看要不要发“我在”、补配对
                if next.state == "ok" {
                    crate::discovery::poke(&app);
                }
            }
            let state = app.state::<AppState>();
            if next.state == "ok" && !simulating {
                tokio::select! {
                    r = wait_events(&app, &mut since) => match r {
                        // 一次变化常常连着好几个事件，稍等合并成一次刷新
                        Ok(true) => tokio::time::sleep(Duration::from_millis(300)).await,
                        Ok(false) => {}
                        Err(e) => {
                            log::warn("syncthing", "events-failed", json!({ "error": e }));
                            since = None;
                            tokio::time::sleep(POLL).await;
                        }
                    },
                    _ = state.syncthing.wake.notified() => {}
                }
            } else {
                since = None;
                let delay = if next.state == "starting" { Duration::from_secs(1) } else { POLL };
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = state.syncthing.wake.notified() => {}
                }
            }
        }
    });
}

/// 让 FoxSync 自己拉起的 Syncthing 正常关闭
pub async fn shutdown_own(app: &AppHandle) -> Result<(), String> {
    let key = app.state::<AppState>().daemon.key().ok_or("没有在运行")?;
    let mut t = target(app);
    t.key = Some(key);
    request(&client(), &t, Method::POST, "/rest/system/shutdown", None).await.map(|_| ()).map_err(|_| "关闭请求失败".into())
}

/// 接管时让别人启动的 Syncthing 正常关闭，用配置文件里的 key
pub async fn shutdown_external(app: &AppHandle) -> Result<(), String> {
    let (_, key) = std::fs::read_to_string(config_path()).map(|xml| parse_gui(&xml)).unwrap_or((None, None));
    let mut t = target(app);
    t.key = key;
    request(&client(), &t, Method::POST, "/rest/system/shutdown", None).await.map(|_| ()).map_err(|_| "关闭请求失败".into())
}

/// 把本机在 Syncthing 里的设备名改成昵称；Syncthing 没在跑就跳过，下次保存昵称时再写
pub async fn set_own_name(app: &AppHandle, name: &str) -> Result<(), String> {
    let my_id = app.state::<AppState>().syncthing.status.lock().unwrap().my_id.clone();
    if my_id.is_empty() {
        return Ok(());
    }
    let t = target(app);
    let path = format!("/rest/config/devices/{my_id}");
    match request(&client(), &t, Method::PATCH, &path, Some(json!({ "name": name }))).await {
        Ok(_) => {
            log::info("syncthing", "own-name-set", json!({}));
            app.state::<AppState>().syncthing.refresh();
            Ok(())
        }
        Err(Failure::Unauthorized) => Err("Syncthing 拒绝了请求，API key 不对".into()),
        Err(Failure::Unreachable(e)) | Err(Failure::Other(e)) => Err(format!("写入 Syncthing 设备名失败：{e}")),
    }
}

/// 重新拉起内置的 Syncthing（起不来或连不上时，菜单栏和整页提示里的“重新启动”）
pub fn launch(app: &AppHandle) {
    daemon::restart(app);
    app.state::<AppState>().syncthing.refresh();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_gui_address_and_key() {
        let xml = r#"<configuration><folder id="a"></folder><gui enabled="true" tls="false" debugging="false">
            <address>127.0.0.1:8384</address>
            <apikey>abc123</apikey>
        </gui><options></options></configuration>"#;
        assert_eq!(parse_gui(xml), (Some("http://127.0.0.1:8384".into()), Some("abc123".into())));
    }
    #[test]
    fn parses_tls_and_wildcard() {
        let xml = r#"<gui enabled="true" tls="true"><address>0.0.0.0:8384</address></gui>"#;
        assert_eq!(parse_gui(xml), (Some("https://127.0.0.1:8384".into()), None));
    }
    #[test]
    fn missing_gui() {
        assert_eq!(parse_gui("<configuration/>"), (None, None));
    }
    #[test]
    fn parses_pending() {
        let folders = json!({
            "k3n9q-x7w2p": { "offeredBy": {
                "BBB": { "time": "2026-11-16T10:00:00Z", "label": "接力资料" },
                "AAA": { "time": "2026-11-16T09:00:00Z", "label": "旧名字" }
            }}
        });
        let f = parse_pending_folders(&folders);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].label, "旧名字");
        assert_eq!(f[0].offered_by, vec!["AAA".to_string(), "BBB".to_string()]);
        let devices = json!({ "CCC": { "time": "2026-11-16T10:00:00Z", "name": "office-m5", "address": "relay://x" } });
        assert_eq!(parse_pending_devices(&devices)[0].name, "office-m5");
        assert!(parse_pending_folders(&Value::Null).is_empty());
    }
    #[test]
    fn parses_ignored() {
        let devices = json!([
            { "deviceID": "AAA", "ignoredFolders": [{ "id": "f1", "label": "旧的", "time": "2026-11-16T10:00:00Z" }] },
            { "deviceID": "BBB", "ignoredFolders": [{ "id": "f2", "label": "新的", "time": "2026-11-17T10:00:00Z" }] },
            { "deviceID": "CCC" }
        ]);
        let list = parse_ignored(&devices);
        assert_eq!(list.iter().map(|f| (f.id.as_str(), f.device.as_str())).collect::<Vec<_>>(), vec![("f2", "BBB"), ("f1", "AAA")]);
    }
    #[test]
    fn encodes_folder_ids() {
        assert_eq!(urlencode("abc-12_3.x"), "abc-12_3.x");
        assert_eq!(urlencode("a b/中"), "a%20b%2F%E4%B8%AD");
    }
}
