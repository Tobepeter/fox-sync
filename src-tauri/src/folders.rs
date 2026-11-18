//! 新建文件夹、加入别人共享的文件夹、接受或忽略请求连接的设备
//! 顺序照 Syncthing 的规矩：设备先在设备表里，再建文件夹；改单个字段用 PATCH，POST 同 ID 会整条覆盖
use crate::{
    log,
    syncthing::{self, client, get, request, target, text, urlencode, Failure},
    AppState,
};
use rand::Rng;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const KINDS: [&str; 3] = ["sendreceive", "sendonly", "receiveonly"];
/// 自动加入时写的 .stignore，和前端 buildIgnores(defaultIgnores(), '') 的结果一致（tests/ignores.test.ts 校验）
pub const DEFAULT_IGNORES: &str = r#"// FoxSync 生成的忽略规则，只对这台机器生效
// 语法见 https://docs.syncthing.net/users/ignoring.html

// 系统文件
(?d).DS_Store
(?d)._*
(?d).Spotlight-V100
(?d).Trashes

// 临时文件
(?d)*.tmp
(?d)*.swp
(?d)~$*

// 依赖目录
// node_modules
// .venv
// __pycache__

// 构建产物
// dist
// build
// target

// Git 仓库数据
// .git

// 环境变量文件
// .env
// .env.*

// 自定义"#;

/// 回收站式版本保留的天数
const KEEP_DAYS: &str = "30";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct FolderRequest {
    /// 加入时是对方的文件夹 ID；新建时留空，自动生成
    pub id: Option<String>,
    pub label: String,
    /// 本地路径，可以 `~/` 开头
    pub path: String,
    /// sendreceive、sendonly、receiveonly
    pub kind: String,
    /// 共享给哪些设备，必须已在设备表里
    pub devices: Vec<String>,
    /// 写进 `.stignore` 的内容；目录里已有 `.stignore` 时不覆盖
    pub ignores: String,
    /// 回收站式版本：保留别的设备删除或覆盖的旧文件
    pub versioning: bool,
    /// 共享给频道里的所有设备，以后配对的新设备也自动加进来
    pub auto_share: bool,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct PathInfo {
    /// 展开 `~` 之后的绝对路径
    pub path: String,
    pub exists: bool,
    pub is_dir: bool,
    /// 目录里有多少项（不算 .DS_Store 和 Syncthing 自己的 .stfolder、.stignore、.stversions）
    pub entries: u32,
    pub has_ignores: bool,
    /// 和已有的哪个文件夹重叠（位置相同或互相包含），没有为空
    pub overlap: String,
}

/// 照 Syncthing 网页管理页的格式：两组 5 位小写字母和数字，如 `k3n9q-x7w2p`
pub fn random_id() -> String {
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    let mut part = || (0..5).map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char).collect::<String>();
    format!("{}-{}", part(), part())
}

pub fn expand(path: &str) -> PathBuf {
    let path = path.trim();
    match path.strip_prefix("~/").or(if path == "~" { Some("") } else { None }) {
        Some(rest) => std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join(rest),
        None => PathBuf::from(path),
    }
}

/// 位置相同或互相包含都算重叠：同一批文件会被两个文件夹各同步一次
pub fn overlapping<'a>(path: &Path, existing: &'a [syncthing::Folder]) -> Option<&'a syncthing::Folder> {
    existing.iter().find(|f| {
        let other = Path::new(&f.path);
        path.starts_with(other) || other.starts_with(path)
    })
}

fn display(f: &syncthing::Folder) -> &str {
    if f.label.is_empty() {
        &f.id
    } else {
        &f.label
    }
}

pub fn inspect(path: &str, existing: &[syncthing::Folder]) -> PathInfo {
    let full = expand(path);
    let meta = std::fs::metadata(&full).ok();
    let is_dir = meta.as_ref().is_some_and(|m| m.is_dir());
    let entries = if is_dir {
        std::fs::read_dir(&full)
            .map(|r| {
                r.filter_map(Result::ok)
                    .filter(|e| !matches!(e.file_name().to_str(), Some(".DS_Store" | ".stignore" | ".stfolder" | ".stversions")))
                    .count() as u32
            })
            .unwrap_or(0)
    } else {
        0
    };
    PathInfo {
        path: full.to_string_lossy().into(),
        exists: meta.is_some(),
        is_dir,
        entries,
        has_ignores: full.join(".stignore").exists(),
        overlap: if path.trim().is_empty() { None } else { overlapping(&full, existing) }.map(|f| display(f).to_string()).unwrap_or_default(),
    }
}

/// 检查请求，返回清洗过的标签和绝对路径
fn validate(req: &FolderRequest, existing: &[syncthing::Folder]) -> Result<(String, PathBuf), String> {
    let label = req.label.trim().to_string();
    if label.is_empty() {
        return Err("名称不能为空".into());
    }
    if !KINDS.contains(&req.kind.as_str()) {
        return Err("未知的同步方向".into());
    }
    if let Some(id) = &req.id {
        // ID 里带 / 时对方的待处理记录会被当成坏数据删掉
        if id.is_empty() || id.contains('/') {
            return Err("文件夹 ID 不合法".into());
        }
        if existing.iter().any(|f| &f.id == id) {
            return Err("已经加入过这个文件夹".into());
        }
    }
    let path = expand(&req.path);
    if !path.is_absolute() || req.path.trim().is_empty() {
        return Err("请选择一个本地目录".into());
    }
    if let Some(f) = overlapping(&path, existing) {
        return Err(format!("这个位置和已有的文件夹「{}」重叠", display(f)));
    }
    if path.exists() && !path.is_dir() {
        return Err("这个位置是一个文件，不是目录".into());
    }
    Ok((label, path))
}

fn failed(what: &str) -> impl Fn(Failure) -> String + '_ {
    move |f| match f {
        Failure::Unauthorized => "Syncthing 拒绝了请求，API key 不对".into(),
        Failure::Unreachable(e) | Failure::Other(e) => format!("{what}失败：{e}"),
    }
}

/// 新建或加入：建目录 → 写 `.stignore`（已有就不动）→ 以 Syncthing 的默认值为底建文件夹
/// 忽略规则在建文件夹之前写进目录，第一次扫描就生效，不需要先暂停再取消暂停
pub async fn create(app: &AppHandle, req: FolderRequest) -> Result<String, String> {
    let status = app.state::<AppState>().syncthing.status.lock().unwrap().clone();
    if status.state != "ok" {
        return Err("Syncthing 没在运行".into());
    }
    let (label, path) = validate(&req, &status.folders)?;
    let known: Vec<&str> = status.devices.iter().filter(|d| !d.me).map(|d| d.id.as_str()).collect();
    // 加入时一定共享回给发出邀请的设备，不靠前端传，否则对方那边连不上这个文件夹
    let offered = req.id.as_ref().and_then(|id| status.pending_folders.iter().find(|p| &p.id == id));
    let mut devices: Vec<&String> = offered.map(|p| p.offered_by.iter().collect()).unwrap_or_default();
    for d in &req.devices {
        if !devices.contains(&d) {
            devices.push(d);
        }
    }
    let peers: Vec<String> = app.state::<AppState>().data.lock().unwrap().peers.iter().map(|p| p.syncthing_id.clone()).collect();
    if req.auto_share {
        devices.extend(peers.iter().filter(|p| !req.devices.contains(p)));
    }
    devices.retain(|d| known.contains(&d.as_str()));
    devices.sort_unstable();
    devices.dedup();
    std::fs::create_dir_all(&path).map_err(|e| format!("建不了目录：{e}"))?;
    let ignore_file = path.join(".stignore");
    let wrote_ignores = !ignore_file.exists() && !req.ignores.trim().is_empty();
    if wrote_ignores {
        std::fs::write(&ignore_file, format!("{}\n", req.ignores.trim_end())).map_err(|e| format!("写不了 .stignore：{e}"))?;
    }
    let t = target(app);
    let c = client();
    let mut folder = get(&c, &t, "/rest/config/defaults/folder").await.map_err(failed("读取 Syncthing 默认设置"))?;
    let id = req.id.clone().unwrap_or_else(random_id);
    folder["id"] = json!(id);
    folder["label"] = json!(label);
    folder["path"] = json!(path.to_string_lossy());
    folder["type"] = json!(req.kind);
    folder["paused"] = json!(false);
    let mut members = vec![json!({ "deviceID": status.my_id })];
    members.extend(devices.iter().map(|d| json!({ "deviceID": d })));
    folder["devices"] = Value::Array(members);
    if req.versioning {
        folder["versioning"]["type"] = json!("trashcan");
        folder["versioning"]["params"] = json!({ "cleanoutDays": KEEP_DAYS });
    }
    request(&c, &t, Method::POST, "/rest/config/folders", Some(folder)).await.map_err(failed("建文件夹"))?;
    if req.auto_share {
        let state = app.state::<AppState>();
        let mut d = state.data.lock().unwrap();
        if !d.auto_share.contains(&id) {
            d.auto_share.push(id.clone());
            let _ = crate::data::save(&d);
        }
        drop(d);
        crate::notify(app);
    }
    log::info(
        "folders",
        if req.id.is_some() { "joined" } else { "created" },
        json!({ "id": id, "kind": req.kind, "devices": devices.len(), "ignores": wrote_ignores, "versioning": req.versioning }),
    );
    app.state::<AppState>().syncthing.refresh();
    Ok(id)
}

/// 不加入：在每台共享它的设备上记一笔 ignoredFolders，对方再共享也不再提示
pub async fn ignore_folder(app: &AppHandle, id: String) -> Result<(), String> {
    let status = app.state::<AppState>().syncthing.status.lock().unwrap().clone();
    let pending = status.pending_folders.iter().find(|p| p.id == id).ok_or("这个邀请已经不在了")?;
    let t = target(app);
    let c = client();
    let now = chrono::Utc::now().to_rfc3339();
    for device in &pending.offered_by {
        let path = format!("/rest/config/devices/{device}");
        let config = get(&c, &t, &path).await.map_err(failed("读取设备设置"))?;
        let mut ignored = config["ignoredFolders"].as_array().cloned().unwrap_or_default();
        if !ignored.iter().any(|f| text(f, "id") == id) {
            ignored.push(json!({ "id": id, "label": pending.label, "time": now }));
        }
        request(&c, &t, Method::PATCH, &path, Some(json!({ "ignoredFolders": ignored }))).await.map_err(failed("忽略文件夹"))?;
        let _ = request(
            &c,
            &t,
            Method::DELETE,
            &format!("/rest/cluster/pending/folders?folder={}&device={device}", urlencode(&id)),
            None,
        )
        .await;
    }
    log::info("folders", "ignored", json!({ "id": id }));
    app.state::<AppState>().syncthing.refresh();
    Ok(())
}

/// 接受请求连接的设备：以默认值为底加进设备表，名字用对方自报的
pub async fn accept_device(app: &AppHandle, id: String) -> Result<(), String> {
    let status = app.state::<AppState>().syncthing.status.lock().unwrap().clone();
    let pending = status.pending_devices.iter().find(|p| p.id == id).ok_or("这个请求已经不在了")?;
    let t = target(app);
    let c = client();
    let mut device = get(&c, &t, "/rest/config/defaults/device").await.map_err(failed("读取 Syncthing 默认设置"))?;
    device["deviceID"] = json!(id);
    device["name"] = json!(pending.name);
    request(&c, &t, Method::POST, "/rest/config/devices", Some(device)).await.map_err(failed("添加设备"))?;
    crate::manage::settle(app, &id);
    log::info("devices", "accepted", json!({}));
    app.state::<AppState>().syncthing.refresh();
    Ok(())
}

/// 忽略请求连接的设备：写进 remoteIgnoredDevices，之后它再连也不提示
pub async fn ignore_device(app: &AppHandle, id: String) -> Result<(), String> {
    let status = app.state::<AppState>().syncthing.status.lock().unwrap().clone();
    let pending = status.pending_devices.iter().find(|p| p.id == id).ok_or("这个请求已经不在了")?.clone();
    let t = target(app);
    let c = client();
    let mut config = get(&c, &t, "/rest/config").await.map_err(failed("读取 Syncthing 设置"))?;
    let mut ignored = config["remoteIgnoredDevices"].as_array().cloned().unwrap_or_default();
    if !ignored.iter().any(|d| text(d, "deviceID") == id) {
        ignored.push(json!({
            "deviceID": id,
            "name": pending.name,
            "address": pending.address,
            "time": chrono::Utc::now().to_rfc3339(),
        }));
    }
    config["remoteIgnoredDevices"] = Value::Array(ignored);
    request(&c, &t, Method::PUT, "/rest/config", Some(config)).await.map_err(failed("忽略设备"))?;
    let _ = request(&c, &t, Method::DELETE, &format!("/rest/cluster/pending/devices?device={id}"), None).await;
    log::info("devices", "ignored", json!({}));
    app.state::<AppState>().syncthing.refresh();
    Ok(())
}

/// 恢复忽略过的设备：从 remoteIgnoredDevices 里删掉，它下次来连时重新出现在“请求连接”里
pub async fn restore_device(app: &AppHandle, id: String) -> Result<(), String> {
    let t = target(app);
    let c = client();
    let mut config = get(&c, &t, "/rest/config").await.map_err(failed("读取 Syncthing 设置"))?;
    let mut ignored = config["remoteIgnoredDevices"].as_array().cloned().unwrap_or_default();
    ignored.retain(|d| text(d, "deviceID") != id);
    config["remoteIgnoredDevices"] = Value::Array(ignored);
    request(&c, &t, Method::PUT, "/rest/config", Some(config)).await.map_err(failed("恢复设备"))?;
    log::info("devices", "ignore-restored", json!({}));
    app.state::<AppState>().syncthing.refresh();
    Ok(())
}

/// 自动加入时的目录名：文件夹名去掉路径分隔符，空了用 ID
pub fn dir_name(label: &str, id: &str) -> String {
    let name: String = label.trim().chars().map(|c| if matches!(c, '/' | ':' | '\\') { '-' } else { c }).collect();
    let name = name.trim_matches('.').trim().to_string();
    if name.is_empty() {
        id.to_string()
    } else {
        name
    }
}

/// 给自动加入挑位置：存放位置/文件夹名；已有内容或和已有文件夹重叠，就改成“文件夹名 (ID)”；还不行返回 None，留在“可加入”
pub fn join_path(root: &str, label: &str, id: &str, existing: &[syncthing::Folder]) -> Option<PathBuf> {
    let root = expand(root);
    let name = dir_name(label, id);
    [name.clone(), format!("{name} ({id})")].into_iter().map(|n| root.join(n)).find(|path| {
        let info = inspect(&path.to_string_lossy(), existing);
        info.overlap.is_empty() && (!info.exists || (info.is_dir && info.entries == 0))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn req(path: &str) -> FolderRequest {
        FolderRequest {
            id: None,
            label: " 资料 ".into(),
            path: path.into(),
            kind: "sendreceive".into(),
            devices: vec![],
            ignores: String::new(),
            versioning: true,
            auto_share: true,
        }
    }
    fn folder(id: &str, path: &str) -> syncthing::Folder {
        syncthing::Folder { id: id.into(), label: "旧的".into(), path: path.into(), ..Default::default() }
    }
    #[test]
    fn random_ids_look_like_syncthing() {
        let id = random_id();
        assert_eq!(id.len(), 11);
        assert_eq!(&id[5..6], "-");
        assert!(id.chars().all(|c| c == '-' || c.is_ascii_lowercase() || c.is_ascii_digit()));
        assert_ne!(random_id(), id);
    }
    #[test]
    fn picks_join_paths() {
        assert_eq!(dir_name(" 资料/2026: 春 ", "abc"), "资料-2026- 春");
        assert_eq!(dir_name("  ", "abc"), "abc");
        let root = std::env::temp_dir().join(format!("fox-sync-join-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("资料")).unwrap();
        std::fs::write(root.join("资料/a.txt"), "x").unwrap();
        let root_s = root.to_string_lossy().to_string();
        // 同名目录有内容，换成带 ID 的
        assert_eq!(join_path(&root_s, "资料", "k1", &[]), Some(root.join("资料 (k1)")));
        assert_eq!(join_path(&root_s, "新的", "k2", &[]), Some(root.join("新的")));
        // 和已有文件夹重叠的不能用
        let existing = [folder("x", &root_s)];
        assert_eq!(join_path(&root_s, "新的", "k2", &existing), None);
        let _ = std::fs::remove_dir_all(&root);
    }
    #[test]
    fn expands_home() {
        let home = std::env::var("HOME").unwrap();
        assert_eq!(expand("~/FoxSync/a"), PathBuf::from(format!("{home}/FoxSync/a")));
        assert_eq!(expand(" /tmp/a "), PathBuf::from("/tmp/a"));
    }
    #[test]
    fn validates_requests() {
        let existing = [folder("a", "/tmp/fox-sync-test/a")];
        assert_eq!(validate(&req("/tmp/fox-sync-test/b"), &existing).unwrap().0, "资料");
        assert!(validate(&req("relative"), &existing).is_err());
        assert!(validate(&req(""), &existing).is_err());
        assert!(validate(&req("/tmp/fox-sync-test/a/inner"), &existing).unwrap_err().contains("重叠"));
        assert!(validate(&req("/tmp/fox-sync-test"), &existing).unwrap_err().contains("重叠"));
        // 位置相同也算重叠
        assert!(validate(&req("/tmp/fox-sync-test/a"), &existing).unwrap_err().contains("重叠"));
        assert_eq!(inspect("/tmp/fox-sync-test/a/x", &existing).overlap, "旧的");
        assert_eq!(inspect("/tmp/fox-sync-test/ab", &existing).overlap, "");
        assert!(validate(&FolderRequest { id: Some("x/y".into()), ..req("/tmp/c") }, &existing).is_err());
        assert!(validate(&FolderRequest { id: Some("a".into()), ..req("/tmp/c") }, &existing).is_err());
        assert!(validate(&FolderRequest { kind: "receiveencrypted".into(), ..req("/tmp/c") }, &existing).is_err());
        assert!(validate(&FolderRequest { label: "  ".into(), ..req("/tmp/c") }, &existing).is_err());
    }
}
