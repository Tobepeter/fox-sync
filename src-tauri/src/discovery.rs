//! ntfy 频道发现：启动后发一条“我在”，收到别人的就把它加进本机 Syncthing，并回一条“我也在”
//! 只做发现，不存频道状态、不定期重发；配对之后在线状态看 Syncthing 自己的连接
//! 订阅照 FoxNudge：JSON 长连接、断线退避重连、带游标补收、睡眠唤醒后立即重连
use crate::{
    crypto,
    data::{self, Peer},
    log,
    syncthing::{client, get, request, target, text, Failure},
    AppState,
};
use futures_util::StreamExt;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant, SystemTime},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::watch;

/// ntfy 默认 45 秒一次心跳，超过这个时间没有任何数据就当作断线
const STALL: Duration = Duration::from_secs(110);
/// 连上之前多少秒的消息算补收
const BACKLOG_GRACE: i64 = 5;

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Channel {
    /// off：设置里关了；unconfigured：这个版本没内置频道；connecting；connected；waiting：断线，等着重连
    pub state: String,
    pub error: String,
    pub topic: String,
    /// 下次重连的时间，毫秒
    pub retry_at: Option<i64>,
    /// 这次启动已经发过“我在”
    pub announced: bool,
}

/// 频道里传的消息，整条加密
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Hello {
    pub v: u8,
    /// hello：我在；reply：我也在（回复别人的 hello，收到的人不再回）
    pub kind: String,
    /// FoxSync ID
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub avatar: String,
    /// Syncthing 设备 ID
    pub syncthing: String,
}

pub struct Hub {
    pub status: Mutex<Channel>,
    restart: watch::Sender<u64>,
    /// 用哪个 Syncthing 设备 ID 发过“我在”；Syncthing 设备 ID 变了要重发
    announced_for: Mutex<String>,
    announcing: AtomicBool,
    reconciling: tokio::sync::Mutex<()>,
    /// 这次启动里已经自动加入过（或正在加入）的文件夹 ID，状态还没刷新时不重复加
    joined: Mutex<std::collections::HashSet<String>>,
    client: reqwest::Client,
}
impl Default for Hub {
    fn default() -> Self {
        Self {
            status: Mutex::new(Channel { state: "connecting".into(), ..Default::default() }),
            restart: watch::channel(0).0,
            announced_for: Mutex::new(String::new()),
            announcing: AtomicBool::new(false),
            reconciling: tokio::sync::Mutex::new(()),
            joined: Mutex::new(Default::default()),
            client: reqwest::Client::builder()
                .user_agent(concat!("FoxSync/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(Duration::from_secs(10))
                .build()
                .expect("HTTP 客户端"),
        }
    }
}
impl Hub {
    /// 设置变化、睡眠唤醒都通过它让订阅重新开始
    pub fn restart(&self, reason: &str) {
        log::info("channel", "restart", json!({ "reason": reason }));
        self.restart.send_modify(|g| *g += 1);
    }
}

#[derive(Clone)]
struct Config {
    server: String,
    topic: String,
    token: String,
    key: String,
}

fn builtin(value: Option<&'static str>) -> Option<String> {
    value.map(|v| v.trim().trim_end_matches('/').to_string()).filter(|v| !v.is_empty())
}

/// 频道全部来自构建时注入的 .env（sops 解出），没有就不发现
fn config() -> Option<Config> {
    let mut topic = builtin(option_env!("FOX_SYNC_DEFAULT_TOPIC"))?;
    // 沙盒测试用另一个主题，免得测试设备的“我在”留在正式频道里，被真实机器加进 Syncthing
    if crate::daemon::sandbox_home().is_some() {
        topic.push_str("-sandbox");
    }
    Some(Config {
        server: builtin(option_env!("FOX_SYNC_DEFAULT_SERVER"))?,
        topic,
        token: builtin(option_env!("FOX_SYNC_DEFAULT_TOKEN")).unwrap_or_default(),
        key: builtin(option_env!("FOX_SYNC_DEFAULT_KEY"))?,
    })
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn set_status(app: &AppHandle, update: impl FnOnce(&mut Channel)) {
    let hub = &app.state::<AppState>().hub;
    let next = {
        let mut status = hub.status.lock().unwrap();
        let before = status.clone();
        update(&mut status);
        if *status == before {
            return;
        }
        status.clone()
    };
    let _ = app.emit("channel", &next);
}

fn backoff(attempts: u32, auth: bool) -> Duration {
    if auth {
        // 令牌错了重试也没用，放慢
        return Duration::from_secs(300);
    }
    let base = 2u64.saturating_pow(attempts.min(6)).min(60);
    Duration::from_millis(base * 1000 + rand::random::<u64>() % 1000)
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(worker(app.clone()));
    // 睡眠时单调时钟停走，醒来后用墙钟差值发现，立即重连补收
    std::thread::spawn(move || {
        let tick = Duration::from_secs(5);
        let mut wall = SystemTime::now();
        let mut mono = Instant::now();
        loop {
            std::thread::sleep(tick);
            let wall_gap = wall.elapsed().unwrap_or_default();
            let mono_gap = mono.elapsed();
            wall = SystemTime::now();
            mono = Instant::now();
            if wall_gap > mono_gap + Duration::from_secs(20) {
                app.state::<AppState>().hub.restart("wake");
            }
        }
    });
}

enum Lost {
    Auth(String),
    Other(String),
}

async fn worker(app: AppHandle) {
    let mut restart = app.state::<AppState>().hub.restart.subscribe();
    let mut attempts: u32 = 0;
    loop {
        restart.borrow_and_update();
        // 频道一直连着：它只用来交换设备码，加不加设备由“自动添加”和用户决定
        let Some(cfg) = config() else {
            set_status(&app, |s| *s = Channel { state: "unconfigured".into(), ..Default::default() });
            let _ = restart.changed().await;
            continue;
        };
        set_status(&app, |s| {
            s.state = "connecting".into();
            s.topic = cfg.topic.clone();
            s.retry_at = None;
        });
        let lost = tokio::select! {
            lost = run(&app, &cfg, &mut attempts) => lost,
            _ = restart.changed() => {
                attempts = 0;
                continue;
            }
        };
        attempts += 1;
        let (auth, reason) = match lost {
            Lost::Auth(r) => (true, r),
            Lost::Other(r) => (false, r),
        };
        let delay = backoff(attempts, auth);
        log::warn("channel", "disconnected", json!({ "reason": reason, "attempt": attempts, "retry_ms": delay.as_millis() as u64 }));
        set_status(&app, |s| {
            s.state = "waiting".into();
            s.error = reason;
            s.retry_at = Some(now_ms() + delay.as_millis() as i64);
        });
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = restart.changed() => { attempts = 0; }
        }
    }
}

fn status_lost(code: u16) -> Lost {
    match code {
        401 | 403 => Lost::Auth("令牌无效，或没有这个主题的权限".into()),
        429 => Lost::Other("请求太频繁，被服务器限流".into()),
        code => Lost::Other(format!("服务器返回 {code}")),
    }
}

fn network_lost(e: reqwest::Error) -> Lost {
    log::warn("channel", "request-failed", json!({ "connect": e.is_connect(), "timeout": e.is_timeout(), "detail": log::redact_text(&e.to_string()) }));
    Lost::Other(if e.is_connect() {
        "连不上服务器".into()
    } else if e.is_timeout() {
        "连接超时".into()
    } else {
        "网络错误".into()
    })
}

async fn run(app: &AppHandle, cfg: &Config, attempts: &mut u32) -> Lost {
    // 没有游标就从服务器缓存的最早一条开始（NAS 上缓存 72 小时），补收离线期间别人的“我在”
    let cursor = app.state::<AppState>().data.lock().unwrap().cursor.clone().unwrap_or_else(|| "all".into());
    let mut req = app.state::<AppState>().hub.client.get(format!("{}/{}/json?since={cursor}", cfg.server, cfg.topic));
    if !cfg.token.is_empty() {
        req = req.bearer_auth(&cfg.token);
    }
    let response = match req.send().await {
        Ok(r) => r,
        Err(e) => return network_lost(e),
    };
    if !response.status().is_success() {
        // 游标过期或不合法时服务器返回 400：清掉，下次从头补收
        if response.status().as_u16() == 400 {
            let state = app.state::<AppState>();
            let mut d = state.data.lock().unwrap();
            d.cursor = None;
            let _ = data::save(&d);
        }
        return status_lost(response.status().as_u16());
    }
    let connected = chrono::Utc::now().timestamp();
    *attempts = 0;
    log::info("channel", "connected", json!({ "topic": cfg.topic, "cursor": cursor != "all" }));
    set_status(app, |s| {
        s.state = "connected".into();
        s.error.clear();
        s.retry_at = None;
    });
    poke(app);
    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = vec![];
    loop {
        let chunk = match tokio::time::timeout(STALL, stream.next()).await {
            Err(_) => return Lost::Other("长时间没有心跳".into()),
            Ok(None) => return Lost::Other("连接被服务器关闭".into()),
            Ok(Some(Err(e))) => return network_lost(e),
            Ok(Some(Ok(chunk))) => chunk,
        };
        buffer.extend_from_slice(&chunk);
        while let Some(pos) = buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buffer.drain(..=pos).collect();
            let Ok(event) = serde_json::from_slice::<Value>(&line) else { continue };
            if event["event"] == "message" {
                let backlog = event["time"].as_i64().unwrap_or(0) < connected - BACKLOG_GRACE;
                receive(app, cfg, &event, backlog);
            }
        }
    }
}

/// 记下或更新这台设备，返回它是不是第一次见
/// 同一个 FoxSync ID 换了 Syncthing 设备 ID：Syncthing 重装过，旧 ID 记进 replaced 等着换掉；
/// 不认识的 FoxSync ID 但 Syncthing 设备 ID 认识：对方清过 FoxSync 数据，沿用原来那条
pub fn upsert(peers: &mut Vec<Peer>, hello: &Hello, seen: i64) -> bool {
    let index = peers
        .iter()
        .position(|p| p.id == hello.id)
        .or_else(|| peers.iter().position(|p| !hello.syncthing.is_empty() && p.syncthing_id == hello.syncthing));
    let Some(i) = index else {
        peers.push(Peer {
            id: hello.id.clone(),
            name: hello.name.clone(),
            avatar: hello.avatar.clone(),
            syncthing_id: hello.syncthing.clone(),
            replaced: vec![],
            seen,
            settled: false,
        });
        return true;
    };
    let p = &mut peers[i];
    if !hello.syncthing.is_empty() && p.syncthing_id != hello.syncthing {
        if !p.syncthing_id.is_empty() && !p.replaced.contains(&p.syncthing_id) {
            p.replaced.push(p.syncthing_id.clone());
        }
        p.syncthing_id = hello.syncthing.clone();
    }
    p.id = hello.id.clone();
    p.name = hello.name.clone();
    p.avatar = hello.avatar.clone();
    p.seen = p.seen.max(seen);
    // 一个 Syncthing 设备 ID 只属于一台：别的记录还拿着它就是过时的，去掉，它等着换掉的旧 ID 并过来
    if !hello.syncthing.is_empty() {
        let mut stale = vec![];
        peers.retain(|q| {
            let keep = q.id == hello.id || q.syncthing_id != hello.syncthing;
            if !keep {
                stale.extend(q.replaced.clone());
            }
            keep
        });
        if let Some(p) = peers.iter_mut().find(|q| q.id == hello.id) {
            for id in stale {
                if id != p.syncthing_id && !p.replaced.contains(&id) {
                    p.replaced.push(id);
                }
            }
        }
    }
    false
}

fn receive(app: &AppHandle, cfg: &Config, event: &Value, backlog: bool) {
    let state = app.state::<AppState>();
    let hello = crypto::open::<Hello>(&cfg.key, event["message"].as_str().unwrap_or_default());
    let (me, is_new) = {
        let mut d = state.data.lock().unwrap();
        if let Some(id) = event["id"].as_str() {
            d.cursor = Some(id.to_string());
        }
        let me = d.identity.id.clone();
        let is_new = match &hello {
            Some(h) if h.id != me && h.v == 1 => upsert(&mut d.peers, h, event["time"].as_i64().unwrap_or(0)),
            _ => false,
        };
        let _ = data::save(&d);
        (me, is_new)
    };
    let Some(hello) = hello else {
        // 频道里别的东西（解不开的、别的版本），只记一笔
        log::warn("channel", "undecryptable", json!({}));
        return;
    };
    if hello.id == me {
        return;
    }
    log::info("channel", "received", json!({ "kind": hello.kind, "from": hello.id, "backlog": backlog, "new": is_new }));
    crate::notify(app);
    // 实时收到的“我在”都回；补收到的只回第一次见的，免得每次启动把旧消息全回一遍
    if hello.kind == "hello" && (!backlog || is_new) {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = publish(&handle, "reply").await {
                log::warn("channel", "reply-failed", json!({ "error": e }));
            }
        });
    }
    poke(app);
}

fn hello(app: &AppHandle, kind: &str) -> Option<Hello> {
    let state = app.state::<AppState>();
    let syncthing = state.syncthing.status.lock().unwrap().my_id.clone();
    if syncthing.is_empty() {
        return None;
    }
    let d = state.data.lock().unwrap();
    Some(Hello {
        v: 1,
        kind: kind.into(),
        id: d.identity.id.clone(),
        name: d.identity.name.clone(),
        avatar: d.settings.avatar_style.clone(),
        syncthing,
    })
}

async fn publish(app: &AppHandle, kind: &str) -> Result<(), String> {
    let cfg = config().ok_or("没有内置频道")?;
    let payload = hello(app, kind).ok_or("还不知道本机的 Syncthing 设备 ID")?;
    let message = crypto::seal(&cfg.key, &payload)?;
    let mut req = app
        .state::<AppState>()
        .hub
        .client
        .post(format!("{}/", cfg.server))
        .timeout(Duration::from_secs(15))
        .json(&json!({ "topic": cfg.topic, "message": message }));
    if !cfg.token.is_empty() {
        req = req.bearer_auth(&cfg.token);
    }
    let res = req.send().await.map_err(|e| match network_lost(e) {
        Lost::Auth(r) | Lost::Other(r) => r,
    })?;
    if !res.status().is_success() {
        return Err(match status_lost(res.status().as_u16()) {
            Lost::Auth(r) | Lost::Other(r) => r,
        });
    }
    log::info("channel", "published", json!({ "kind": kind }));
    Ok(())
}

/// 频道连上、Syncthing 起来、收到消息、建了文件夹时调用：该发“我在”就发，再把认识的设备同步进 Syncthing
pub fn poke(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        announce(&handle).await;
        if let Err(e) = reconcile(&handle).await {
            log::warn("channel", "reconcile-failed", json!({ "error": e }));
        }
    });
}

/// 昵称、头像改了或清过数据后重发一次“我在”，别的机器据此更新名字
pub fn reannounce(app: &AppHandle) {
    app.state::<AppState>().hub.announced_for.lock().unwrap().clear();
    set_status(app, |s| s.announced = false);
    poke(app);
}

async fn announce(app: &AppHandle) {
    let state = app.state::<AppState>();
    let hub = &state.hub;
    let connected = hub.status.lock().unwrap().state == "connected";
    let my_id = state.syncthing.status.lock().unwrap().my_id.clone();
    if !connected || my_id.is_empty() || *hub.announced_for.lock().unwrap() == my_id {
        return;
    }
    if hub.announcing.swap(true, Ordering::SeqCst) {
        return;
    }
    let result = publish(app, "hello").await;
    hub.announcing.store(false, Ordering::SeqCst);
    match result {
        Ok(()) => {
            *hub.announced_for.lock().unwrap() = my_id;
            set_status(app, |s| s.announced = true);
        }
        Err(e) => log::warn("channel", "announce-failed", json!({ "error": e })),
    }
}

fn failed(what: &'static str) -> impl Fn(Failure) -> String {
    move |f| match f {
        Failure::Unauthorized => format!("{what}：API key 不对"),
        Failure::Unreachable(e) | Failure::Other(e) => format!("{what}：{e}"),
    }
}

/// 把频道里认识的设备同步进本机 Syncthing，可以重复调用：
/// 开着“自动添加”时，每台新设备自动加一次；之后加不加、删不删以 Syncthing 的设备列表为准，用户删掉的不再加回来
/// 名字跟着对方的昵称走，Syncthing 重装过的把旧设备换成新的，自动共享的文件夹补上所有已配对的频道设备
pub async fn reconcile(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _guard = state.hub.reconciling.lock().await;
    let status = state.syncthing.status.lock().unwrap().clone();
    if status.state != "ok" || status.my_id.is_empty() {
        return Ok(());
    }
    let (peers, auto_share, auto_add) = {
        let d = state.data.lock().unwrap();
        (d.peers.clone(), d.auto_share.clone(), d.settings.auto_add)
    };
    let peers: Vec<Peer> = peers.into_iter().filter(|p| !p.syncthing_id.is_empty() && p.syncthing_id != status.my_id).collect();
    let t = target(app);
    let c = client();
    let mut changed = false;
    let mut defaults: Option<Value> = None;
    // 这一轮加进 Syncthing 的设备，和已经在里面的一起算“已配对”
    let mut added: Vec<String> = vec![];
    let mut settled: Vec<String> = vec![];
    for p in &peers {
        match status.devices.iter().find(|d| d.id == p.syncthing_id) {
            None if !p.settled && auto_add => {
                add_device(&c, &t, &mut defaults, &p.syncthing_id, &p.name).await?;
                log::info("channel", "paired", json!({ "peer": p.id }));
                added.push(p.syncthing_id.clone());
                settled.push(p.id.clone());
                changed = true;
            }
            None => {}
            Some(d) => {
                // 已经在 Syncthing 里（自动加的、手动接受的都算），以后不再自动管它
                if !p.settled {
                    settled.push(p.id.clone());
                }
                if d.name != p.name && !p.name.is_empty() {
                    let path = format!("/rest/config/devices/{}", p.syncthing_id);
                    request(&c, &t, Method::PATCH, &path, Some(json!({ "name": p.name }))).await.map_err(failed("改设备名"))?;
                    changed = true;
                }
            }
        }
    }
    // Syncthing 重装过的：旧设备还在就把新设备加进来，旧设备在哪些文件夹里新设备就加进哪些，再删掉旧设备
    let mut cleaned = vec![];
    for p in &peers {
        for old in &p.replaced {
            if status.devices.iter().any(|d| &d.id == old) {
                if !status.devices.iter().any(|d| d.id == p.syncthing_id) && !added.contains(&p.syncthing_id) {
                    add_device(&c, &t, &mut defaults, &p.syncthing_id, &p.name).await?;
                    added.push(p.syncthing_id.clone());
                }
                for f in status.folders.iter().filter(|f| f.devices.contains(old)) {
                    share(&c, &t, &f.id, &[p.syncthing_id.as_str()]).await?;
                }
                request(&c, &t, Method::DELETE, &format!("/rest/config/devices/{old}"), None).await.map_err(failed("删除旧设备"))?;
                log::info("channel", "replaced", json!({ "peer": p.id }));
                changed = true;
            }
            cleaned.push((p.id.clone(), old.clone()));
        }
    }
    if !cleaned.is_empty() || !settled.is_empty() {
        let mut d = state.data.lock().unwrap();
        for peer in d.peers.iter_mut() {
            peer.replaced.retain(|old| !cleaned.contains(&(peer.id.clone(), old.clone())));
            if settled.contains(&peer.id) {
                peer.settled = true;
            }
        }
        let _ = data::save(&d);
    }
    let paired = |id: &str| status.devices.iter().any(|d| d.id == id) || added.iter().any(|a| a == id);
    let ids: Vec<&str> = peers.iter().map(|p| p.syncthing_id.as_str()).filter(|id| paired(id)).collect();
    // 自动共享的文件夹：已配对的频道设备都在共享列表里
    for f in status.folders.iter().filter(|f| auto_share.contains(&f.id)) {
        let missing: Vec<&str> = ids.iter().copied().filter(|id| !f.devices.iter().any(|d| d == id)).collect();
        if !missing.is_empty() {
            share(&c, &t, &f.id, &missing).await?;
            log::info("channel", "auto-shared", json!({ "folder": f.id, "devices": missing.len() }));
            changed = true;
        }
    }
    // 频道设备共享来的文件夹：设置里开着“自动加入”就直接加，放在存放位置下，不经过“可加入”
    // 本机已有的不算：那是本机没共享给对方，共不共享由用户在“可加入”里定（2026-11-18 和 m3 互测时发现会反复加入失败）
    let settings = state.data.lock().unwrap().settings.clone();
    if settings.auto_join {
        for p in status.pending_folders.iter().filter(|p| !p.existing && p.offered_by.iter().any(|d| ids.contains(&d.as_str()))) {
            if !state.hub.joined.lock().unwrap().insert(p.id.clone()) {
                continue;
            }
            let label = if p.label.is_empty() { p.id.clone() } else { p.label.clone() };
            let Some(path) = crate::folders::join_path(&settings.join_root, &label, &p.id, &status.folders) else {
                // 位置都被占了，留在“可加入”让用户自己选
                log::warn("channel", "auto-join-skipped", json!({ "folder": p.id }));
                continue;
            };
            let request = crate::folders::FolderRequest {
                id: Some(p.id.clone()),
                label: label.clone(),
                path: path.to_string_lossy().into(),
                kind: "sendreceive".into(),
                devices: p.offered_by.clone(),
                ignores: crate::folders::DEFAULT_IGNORES.into(),
                versioning: true,
                auto_share: true,
            };
            match crate::folders::create(app, request).await {
                Ok(_) => {
                    log::info("channel", "auto-joined", json!({ "folder": p.id }));
                    let _ = app.emit("joined", &label);
                    changed = true;
                }
                Err(e) => {
                    log::warn("channel", "auto-join-failed", json!({ "folder": p.id, "error": e }));
                    state.hub.joined.lock().unwrap().remove(&p.id);
                }
            }
        }
    }
    if changed {
        state.syncthing.refresh();
    }
    Ok(())
}

/// 把设备加进文件夹的共享列表；先读整条，只改 devices 再 PATCH
/// 按 Syncthing 的默认设备设置加一台设备；默认设置一轮只读一次
pub async fn add_device(c: &reqwest::Client, t: &crate::syncthing::Target, defaults: &mut Option<Value>, id: &str, name: &str) -> Result<(), String> {
    if defaults.is_none() {
        *defaults = Some(get(c, t, "/rest/config/defaults/device").await.map_err(failed("读取 Syncthing 默认设置"))?);
    }
    let mut device = defaults.clone().unwrap_or_default();
    device["deviceID"] = json!(id);
    device["name"] = json!(name);
    request(c, t, Method::POST, "/rest/config/devices", Some(device)).await.map_err(failed("添加设备"))?;
    Ok(())
}

async fn share(c: &reqwest::Client, t: &crate::syncthing::Target, folder: &str, devices: &[&str]) -> Result<(), String> {
    let path = format!("/rest/config/folders/{}", crate::syncthing::urlencode(folder));
    let config = get(c, t, &path).await.map_err(failed("读取文件夹设置"))?;
    let mut list = config["devices"].as_array().cloned().unwrap_or_default();
    for d in devices {
        if !list.iter().any(|x| text(x, "deviceID") == *d) {
            list.push(json!({ "deviceID": d }));
        }
    }
    request(c, t, Method::PATCH, &path, Some(json!({ "devices": list }))).await.map_err(failed("共享文件夹"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn hello(id: &str, st: &str) -> Hello {
        Hello { v: 1, kind: "hello".into(), id: id.into(), name: "m5".into(), avatar: "lorelei".into(), syncthing: st.into() }
    }
    #[test]
    fn upsert_tracks_reinstalls_and_wipes() {
        let mut peers = vec![];
        assert!(upsert(&mut peers, &hello("fox1", "ST-A"), 10));
        assert!(!upsert(&mut peers, &hello("fox1", "ST-A"), 20));
        assert_eq!(peers[0].seen, 20);
        // Syncthing 重装：同一个 FoxSync ID，新的 Syncthing ID，旧的等着换掉
        assert!(!upsert(&mut peers, &hello("fox1", "ST-B"), 30));
        assert_eq!((peers[0].syncthing_id.as_str(), peers[0].replaced.clone()), ("ST-B", vec!["ST-A".to_string()]));
        // FoxSync 数据清过：新的 FoxSync ID，Syncthing ID 认识，沿用这一条
        assert!(!upsert(&mut peers, &hello("fox2", "ST-B"), 40));
        assert_eq!((peers.len(), peers[0].id.as_str()), (1, "fox2"));
        assert!(upsert(&mut peers, &hello("fox3", "ST-C"), 50));
        assert_eq!(peers.len(), 2);
        // fox2 换成了 fox3 手里的 Syncthing ID：fox3 那条过时了，去掉
        assert!(!upsert(&mut peers, &hello("fox2", "ST-C"), 60));
        assert_eq!((peers.len(), peers[0].id.as_str(), peers[0].syncthing_id.as_str()), (1, "fox2", "ST-C"));
        assert!(peers[0].replaced.contains(&"ST-B".to_string()));
    }
    #[test]
    fn hello_survives_encryption() {
        let h = hello("fox1", "ST-A");
        let sealed = crypto::seal("k", &h).unwrap();
        assert_eq!(crypto::open::<Hello>("k", &sealed), Some(h));
    }
}
