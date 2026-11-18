//! 已有文件夹和设备的操作：暂停、扫描、改设置、忽略规则、冲突和出错文件、移除
//! 改单个字段一律 PATCH；改共享列表前先读整条，只换 devices
use crate::{
    data,
    log,
    syncthing::{client, get, request, target, text, urlencode, Failure, Folder},
    AppState,
};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::{Duration, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const CONFLICT: &str = ".sync-conflict-";
/// 遍历一个文件夹最多看这么多项，避免超大目录卡住
const WALK_LIMIT: usize = 200_000;
const KEEP_DAYS: &str = "30";

pub(crate) fn failed(what: &'static str) -> impl Fn(Failure) -> String {
    move |f| match f {
        Failure::Unauthorized => format!("{what}失败：Syncthing 拒绝了请求"),
        Failure::Unreachable(e) | Failure::Other(e) => format!("{what}失败：{e}"),
    }
}

pub(crate) fn folder(app: &AppHandle, id: &str) -> Result<Folder, String> {
    app.state::<AppState>()
        .syncthing
        .status
        .lock()
        .unwrap()
        .folders
        .iter()
        .find(|f| f.id == id)
        .cloned()
        .ok_or_else(|| "找不到这个文件夹".to_string())
}

fn folder_path(id: &str) -> String {
    format!("/rest/config/folders/{}", urlencode(id))
}

async fn patch_folder(app: &AppHandle, id: &str, body: Value, what: &'static str) -> Result<(), String> {
    request(&client(), &target(app), Method::PATCH, &folder_path(id), Some(body)).await.map_err(failed(what))?;
    app.state::<AppState>().syncthing.refresh();
    Ok(())
}

/// pause / resume / rescan / override（仅发送：以本机为准）/ revert（仅接收：撤销本地改动）
pub async fn folder_action(app: &AppHandle, id: String, action: String) -> Result<(), String> {
    folder(app, &id)?;
    let q = urlencode(&id);
    match action.as_str() {
        "pause" => patch_folder(app, &id, json!({ "paused": true }), "暂停").await?,
        "resume" => patch_folder(app, &id, json!({ "paused": false }), "恢复").await?,
        "rescan" | "override" | "revert" => {
            let path = match action.as_str() {
                "rescan" => format!("/rest/db/scan?folder={q}"),
                "override" => format!("/rest/db/override?folder={q}"),
                _ => format!("/rest/db/revert?folder={q}"),
            };
            request(&client(), &target(app), Method::POST, &path, None).await.map_err(failed("操作"))?;
            app.state::<AppState>().syncthing.refresh();
        }
        _ => return Err("未知的操作".into()),
    }
    log::info("folders", "action", json!({ "id": id, "action": action }));
    Ok(())
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export, optional_fields))]
pub struct FolderPatch {
    pub label: Option<String>,
    pub kind: Option<String>,
    pub versioning: Option<bool>,
    /// 手动共享的设备（不含本机）；自动共享打开时频道设备会被补上
    pub devices: Option<Vec<String>>,
    pub auto_share: Option<bool>,
}

pub async fn update_folder(app: &AppHandle, id: String, patch: FolderPatch) -> Result<(), String> {
    let current = folder(app, &id)?;
    let mut body = json!({});
    if let Some(label) = &patch.label {
        let label = label.trim();
        if label.is_empty() {
            return Err("名称不能为空".into());
        }
        body["label"] = json!(label);
    }
    if let Some(kind) = &patch.kind {
        if !["sendreceive", "sendonly", "receiveonly"].contains(&kind.as_str()) {
            return Err("未知的同步方向".into());
        }
        body["type"] = json!(kind);
    }
    if let Some(on) = patch.versioning {
        body["versioning"] = if on {
            json!({ "type": "trashcan", "params": { "cleanoutDays": KEEP_DAYS }, "cleanupIntervalS": 3600, "fsPath": "", "fsType": "basic" })
        } else {
            json!({ "type": "", "params": {}, "cleanupIntervalS": 3600, "fsPath": "", "fsType": "basic" })
        };
    }
    let state = app.state::<AppState>();
    if let Some(on) = patch.auto_share {
        let mut d = state.data.lock().unwrap();
        d.auto_share.retain(|f| f != &id);
        if on {
            d.auto_share.push(id.clone());
        }
        let _ = data::save(&d);
    }
    if let Some(devices) = &patch.devices {
        let my_id = state.syncthing.status.lock().unwrap().my_id.clone();
        let mut list = vec![json!({ "deviceID": my_id })];
        list.extend(devices.iter().filter(|d| **d != my_id).map(|d| json!({ "deviceID": d })));
        body["devices"] = Value::Array(list);
    }
    if body.as_object().is_some_and(|o| !o.is_empty()) {
        patch_folder(app, &id, body, "保存").await?;
    }
    log::info("folders", "updated", json!({ "id": id, "previous_kind": current.kind }));
    crate::notify(app);
    // 打开自动共享后立刻把频道设备补进来
    crate::discovery::poke(app);
    Ok(())
}

/// 停止同步：从 Syncthing 里移除，本地文件不动
pub async fn remove_folder(app: &AppHandle, id: String) -> Result<(), String> {
    folder(app, &id)?;
    request(&client(), &target(app), Method::DELETE, &folder_path(&id), None).await.map_err(failed("停止同步"))?;
    {
        let state = app.state::<AppState>();
        let mut d = state.data.lock().unwrap();
        d.auto_share.retain(|f| f != &id);
        let _ = data::save(&d);
        state.syncthing.conflicts.lock().unwrap().remove(&id);
    }
    log::info("folders", "removed", json!({ "id": id }));
    app.state::<AppState>().syncthing.refresh();
    crate::notify(app);
    Ok(())
}

/// `.stignore` 全文；没有就是空串
pub async fn folder_ignores(app: &AppHandle, id: String) -> Result<String, String> {
    folder(app, &id)?;
    let v = get(&client(), &target(app), &format!("/rest/db/ignores?folder={}", urlencode(&id))).await.map_err(failed("读取忽略规则"))?;
    let lines: Vec<&str> = v["ignore"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    Ok(lines.join("\n"))
}

pub async fn set_folder_ignores(app: &AppHandle, id: String, text: String) -> Result<(), String> {
    folder(app, &id)?;
    let lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    let path = format!("/rest/db/ignores?folder={}", urlencode(&id));
    request(&client(), &target(app), Method::POST, &path, Some(json!({ "ignore": lines }))).await.map_err(failed("保存忽略规则"))?;
    log::info("folders", "ignores-saved", json!({ "id": id, "lines": lines.len() }));
    app.state::<AppState>().syncthing.refresh();
    Ok(())
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct FileIssue {
    /// 相对文件夹的路径
    pub path: String,
    /// 出错原因；冲突时是原文件的相对路径
    pub detail: String,
    /// 修改时间，秒；拿不到为 0
    pub time: i64,
}

pub async fn folder_errors(app: &AppHandle, id: String) -> Result<Vec<FileIssue>, String> {
    folder(app, &id)?;
    let v = get(&client(), &target(app), &format!("/rest/folder/errors?folder={}", urlencode(&id))).await.map_err(failed("读取出错文件"))?;
    Ok(v["errors"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|e| FileIssue { path: text(e, "path"), detail: text(e, "error"), time: 0 })
        .collect())
}

/// `报告.sync-conflict-20261116-101500-ABCDEFG.docx` → `报告.docx`
pub fn conflict_original(name: &str) -> Option<String> {
    let start = name.find(CONFLICT)?;
    let rest = &name[start + CONFLICT.len()..];
    // 后缀固定是 日期-时间-设备短 ID，再跟原扩展名
    let tail = rest.splitn(3, '-').nth(2).unwrap_or("");
    let ext = tail.find('.').map(|i| &tail[i..]).unwrap_or("");
    Some(format!("{}{ext}", &name[..start]))
}

/// 遍历目录找冲突副本，跳过 Syncthing 自己的目录
pub fn find_conflicts(root: &Path) -> Vec<String> {
    let mut out = vec![];
    let mut stack = vec![root.to_path_buf()];
    let mut seen = 0usize;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            seen += 1;
            if seen > WALK_LIMIT {
                return out;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if matches!(name.as_str(), ".stversions" | ".stfolder" | ".git" | "node_modules") {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                stack.push(entry.path());
            } else if name.contains(CONFLICT) {
                if let Ok(rel) = entry.path().strip_prefix(root) {
                    out.push(rel.to_string_lossy().into_owned());
                }
            }
        }
    }
    out.sort();
    out
}

fn modified(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn store_conflicts(app: &AppHandle, id: &str, list: Vec<String>) {
    let monitor = &app.state::<AppState>().syncthing;
    let count = list.len() as u32;
    let changed = {
        let mut map = monitor.conflicts.lock().unwrap();
        let changed = map.get(id) != Some(&list);
        map.insert(id.to_string(), list);
        changed
    };
    if changed {
        // 状态里的冲突数要等下一轮刷新 Syncthing 才更新（实测 2–4 秒），先直接改掉，处理完那一行马上消失
        if let Some(f) = monitor.status.lock().unwrap().folders.iter_mut().find(|f| f.id == id) {
            f.conflicts = count;
        }
        monitor.refresh();
    }
}

pub async fn folder_conflicts(app: &AppHandle, id: String) -> Result<Vec<FileIssue>, String> {
    let f = folder(app, &id)?;
    let root = PathBuf::from(&f.path);
    let list = tauri::async_runtime::spawn_blocking({
        let root = root.clone();
        move || find_conflicts(&root)
    })
    .await
    .map_err(|e| e.to_string())?;
    store_conflicts(app, &id, list.clone());
    Ok(list
        .into_iter()
        .map(|rel| {
            let name = Path::new(&rel).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let original = conflict_original(&name).unwrap_or_default();
            let original = Path::new(&rel).with_file_name(original).to_string_lossy().into_owned();
            FileIssue { time: modified(&root.join(&rel)), path: rel, detail: original }
        })
        .collect())
}

/// keep：用冲突副本替换原文件（原文件进废纸篓）；drop：冲突副本进废纸篓
/// 动手前给要动的文件留快照，返回撤销用的 token（见 snapshot.rs）
pub async fn resolve_conflict(app: &AppHandle, id: String, path: String, choice: String) -> Result<String, String> {
    let f = folder(app, &id)?;
    let root = PathBuf::from(&f.path);
    let copy = root.join(&path);
    // 只处理这个文件夹里、名字确实是冲突副本的文件
    if path.contains("..") || !copy.starts_with(&root) || !path.contains(CONFLICT) || !copy.is_file() {
        return Err("找不到这个冲突文件".into());
    }
    let name = copy.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // 只有“用这份”要认出原文件名
    let original = conflict_original(&name).map(|n| copy.with_file_name(n));
    let token = match choice.as_str() {
        "keep" => crate::snapshot::take(&root, &[original.clone().ok_or("认不出原文件名")?, copy.clone()])?,
        "drop" => crate::snapshot::take(&root, std::slice::from_ref(&copy))?,
        _ => return Err("未知的处理方式".into()),
    };
    match choice.as_str() {
        "keep" => {
            let original = original.ok_or("认不出原文件名")?;
            if original.exists() {
                trash::delete(&original).map_err(|e| format!("原文件挪不进废纸篓：{e}"))?;
            }
            std::fs::rename(&copy, &original).map_err(|e| format!("改名失败：{e}"))?;
        }
        _ => trash::delete(&copy).map_err(|e| format!("挪不进废纸篓：{e}"))?,
    }
    log::info("folders", "conflict-resolved", json!({ "id": id, "choice": choice }));
    let list = find_conflicts(&root);
    store_conflicts(app, &id, list);
    Ok(token)
}

/// 撤销刚才的冲突处理：文件放回处理前的样子，以快照为准
pub async fn undo_conflict(app: &AppHandle, id: String, token: String) -> Result<(), String> {
    let root = crate::snapshot::restore(&token)?;
    log::info("folders", "conflict-undone", json!({ "id": id }));
    store_conflicts(app, &id, find_conflicts(&root));
    Ok(())
}

/// 后台每分钟数一遍各文件夹的冲突副本，变了就刷新界面
pub fn start_conflict_watch(app: AppHandle) {
    std::thread::spawn(move || loop {
        let folders: Vec<Folder> = app.state::<AppState>().syncthing.status.lock().unwrap().folders.clone();
        let mut fresh: HashMap<String, Vec<String>> = HashMap::new();
        for f in folders.iter().filter(|f| !f.paused) {
            crate::snapshot::sweep(Path::new(&f.path));
            fresh.insert(f.id.clone(), find_conflicts(Path::new(&f.path)));
        }
        for (id, list) in fresh {
            store_conflicts(&app, &id, list);
        }
        std::thread::sleep(Duration::from_secs(60));
    });
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export, optional_fields))]
pub struct DevicePatch {
    pub name: Option<String>,
    pub paused: Option<bool>,
}

fn is_peer(app: &AppHandle, id: &str) -> bool {
    app.state::<AppState>().data.lock().unwrap().peers.iter().any(|p| p.syncthing_id == id)
}

pub async fn update_device(app: &AppHandle, id: String, patch: DevicePatch) -> Result<(), String> {
    let mut body = json!({});
    if let Some(name) = &patch.name {
        if is_peer(app, &id) {
            return Err("经频道配对的设备名字跟着对方的昵称".into());
        }
        body["name"] = json!(name.trim());
    }
    if let Some(paused) = patch.paused {
        body["paused"] = json!(paused);
    }
    request(&client(), &target(app), Method::PATCH, &format!("/rest/config/devices/{id}"), Some(body)).await.map_err(failed("保存"))?;
    log::info("devices", "updated", json!({ "paused": patch.paused }));
    app.state::<AppState>().syncthing.refresh();
    Ok(())
}

/// 用户自己加过、接受过、移除过的频道设备：自动添加以后不再管它
pub fn settle(app: &AppHandle, syncthing_id: &str) {
    let state = app.state::<AppState>();
    let mut d = state.data.lock().unwrap();
    let mut changed = false;
    for p in d.peers.iter_mut().filter(|p| p.syncthing_id == syncthing_id && !p.settled) {
        p.settled = true;
        changed = true;
    }
    if changed {
        let _ = data::save(&d);
    }
}

/// 移除设备：从 Syncthing 里删掉就是全部；频道设备不会再被自动加回来，在设备页“频道里的其他设备”里能重新添加
pub async fn remove_device(app: &AppHandle, id: String) -> Result<(), String> {
    request(&client(), &target(app), Method::DELETE, &format!("/rest/config/devices/{id}"), None).await.map_err(failed("移除"))?;
    settle(app, &id);
    log::info("devices", "removed", json!({}));
    app.state::<AppState>().syncthing.refresh();
    crate::notify(app);
    Ok(())
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Member {
    pub device: String,
    /// valid：已加入；notSharing：还没加入（或忽略了）；paused：对方暂停了；unknown：离线，不知道
    pub state: String,
    /// 对方的完成度，0~100
    pub completion: f64,
}

/// 文件夹共享给的每台设备，对方有没有加入、同步到多少（`db/completion` 的 remoteState）
pub async fn folder_members(app: &AppHandle, id: String) -> Result<Vec<Member>, String> {
    let f = folder(app, &id)?;
    let t = target(app);
    let c = client();
    let mut out = vec![];
    for device in &f.devices {
        let path = format!("/rest/db/completion?folder={}&device={device}", urlencode(&id));
        let v = get(&c, &t, &path).await.unwrap_or(Value::Null);
        out.push(Member {
            device: device.clone(),
            state: v["remoteState"].as_str().unwrap_or("unknown").to_string(),
            completion: v["completion"].as_f64().unwrap_or(0.0),
        });
    }
    Ok(out)
}

/// 本机主动离线 / 上线：暂停或恢复和所有设备的连接（Syncthing 的全部暂停）
pub async fn set_online(app: &AppHandle, online: bool) -> Result<(), String> {
    let path = if online { "/rest/system/resume" } else { "/rest/system/pause" };
    request(&client(), &target(app), Method::POST, path, None).await.map_err(failed(if online { "上线" } else { "离线" }))?;
    log::info("devices", "online", json!({ "online": online }));
    app.state::<AppState>().syncthing.refresh();
    Ok(())
}

/// 恢复忽略过的邀请：从那台设备的 ignoredFolders 里删掉。对方的共享清单只在连接时发，
/// 删完后短暂暂停再恢复这台设备让它重连，邀请就会重新出现在“可加入”里
pub async fn restore_ignored(app: &AppHandle, device: String, id: String) -> Result<(), String> {
    let t = target(app);
    let c = client();
    let path = format!("/rest/config/devices/{device}");
    let config = get(&c, &t, &path).await.map_err(failed("读取设备设置"))?;
    let mut ignored = config["ignoredFolders"].as_array().cloned().unwrap_or_default();
    ignored.retain(|f| text(f, "id") != id);
    request(&c, &t, Method::PATCH, &path, Some(json!({ "ignoredFolders": ignored }))).await.map_err(failed("恢复"))?;
    let connected = app.state::<AppState>().syncthing.status.lock().unwrap().devices.iter().any(|d| d.id == device && d.connected);
    if connected && !config["paused"].as_bool().unwrap_or(false) {
        let _ = request(&c, &t, Method::PATCH, &path, Some(json!({ "paused": true }))).await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        request(&c, &t, Method::PATCH, &path, Some(json!({ "paused": false }))).await.map_err(failed("重连"))?;
    }
    log::info("folders", "ignore-restored", json!({ "id": id }));
    app.state::<AppState>().syncthing.refresh();
    Ok(())
}

/// 设备详情里逐个文件夹开关共享
/// 手动添加频道里的设备（按 FoxSync ID）：加进 Syncthing，对方没加本机的话，会在它那边出现“请求连接”
pub async fn add_peer(app: &AppHandle, id: String) -> Result<(), String> {
    let peer = app.state::<AppState>().data.lock().unwrap().peers.iter().find(|p| p.id == id).cloned().ok_or("频道里没有这台设备")?;
    if peer.syncthing_id.is_empty() {
        return Err("还不知道这台设备的 Syncthing 设备 ID".into());
    }
    crate::discovery::add_device(&client(), &target(app), &mut None, &peer.syncthing_id, &peer.name).await?;
    settle(app, &peer.syncthing_id);
    log::info("devices", "peer-added", json!({ "peer": peer.id }));
    app.state::<AppState>().syncthing.refresh();
    // 补上自动共享的文件夹、自动加入它共享来的
    crate::discovery::poke(app);
    Ok(())
}

pub async fn share_folder(app: &AppHandle, device: String, folder_id: String, on: bool) -> Result<(), String> {
    let f = folder(app, &folder_id)?;
    let mut devices: Vec<String> = f.devices.clone();
    devices.retain(|d| d != &device);
    if on {
        devices.push(device);
    }
    update_folder(app, folder_id, FolderPatch { devices: Some(devices), ..Default::default() }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn conflict_names() {
        assert_eq!(conflict_original("报告.sync-conflict-20261116-101500-ABCDEFG.docx").as_deref(), Some("报告.docx"));
        assert_eq!(conflict_original("Makefile.sync-conflict-20261116-101500-ABCDEFG").as_deref(), Some("Makefile"));
        assert_eq!(conflict_original("a.tar.sync-conflict-20261116-101500-ABCDEFG.gz").as_deref(), Some("a.tar.gz"));
        assert_eq!(conflict_original("普通文件.txt"), None);
    }
    #[test]
    fn finds_conflicts_and_skips_versions() {
        let root = std::env::temp_dir().join(format!("fox-sync-conflicts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(root.join(".stversions")).unwrap();
        std::fs::write(root.join("sub/a.sync-conflict-20261116-101500-ABCDEFG.txt"), "x").unwrap();
        std::fs::write(root.join(".stversions/b.sync-conflict-20261116-101500-ABCDEFG.txt"), "x").unwrap();
        std::fs::write(root.join("c.txt"), "x").unwrap();
        assert_eq!(find_conflicts(&root), vec!["sub/a.sync-conflict-20261116-101500-ABCDEFG.txt".to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }
}
