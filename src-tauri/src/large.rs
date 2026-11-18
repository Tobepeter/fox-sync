//! 文件夹里的大文件：不自己扫盘，读 Syncthing 已经维护好的文件索引（`/rest/db/browse`，带每个文件的大小）
//! 索引只含参与同步的文件，被忽略的不在里面，正好回答“是什么让这个文件夹同步起来重”
//! 缓存：按文件夹记下 Syncthing 的序号（本机 `sequence` 加各设备的 `remoteSequence`），文件一变序号就涨，
//! 序号没变直接用上次的结果；同一时间只算一份，并发的请求等它算完再读缓存
//! 实测（2026-11-18）：Game Lab 5882 个文件，读索引 0.4 秒；耗时和文件数成正比
use crate::{
    log,
    manage::{failed, folder},
    syncthing::{client, get, target, urlencode},
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::Instant,
};
use tauri::AppHandle;

/// 档位，1024 进制：1 MB、10 MB、100 MB、1 GB
pub const TIERS: [u64; 4] = [1 << 20, 10 << 20, 100 << 20, 1 << 30];
/// 列表最多返回这么多个（从大到小），每档的个数和合计另算，不受这个限制
const LIST_LIMIT: usize = 300;
/// 命中字面忽略规则、要逐个核实的最多问这么多个，再多的直接按忽略算
const VERIFY_LIMIT: usize = 50;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct LargeFile {
    /// 相对文件夹根目录，用 / 分隔
    pub path: String,
    #[cfg_attr(test, ts(type = "number"))]
    pub size: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Tier {
    #[cfg_attr(test, ts(type = "number"))]
    pub min: u64,
    pub count: u32,
    #[cfg_attr(test, ts(type = "number"))]
    pub bytes: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct LargeFiles {
    /// 每档有几个、一共多大
    pub tiers: Vec<Tier>,
    /// 1 MB 以上的，从大到小，最多 300 个
    pub files: Vec<LargeFile>,
}

struct Cached {
    key: String,
    /// 1 MB 以上的全部文件，从大到小；按忽略规则筛、分档都在读缓存之后做，很便宜
    files: Vec<LargeFile>,
}

fn cache() -> &'static Mutex<HashMap<String, Cached>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// 同一时间只算一份：一个文件夹算到一半又来请求，等它算完直接读缓存
fn busy() -> &'static tokio::sync::Mutex<()> {
    static BUSY: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    BUSY.get_or_init(Default::default)
}

pub async fn large_files(app: &AppHandle, id: String) -> Result<LargeFiles, String> {
    folder(app, &id)?;
    let (c, t) = (client(), target(app));
    let q = urlencode(&id);
    let key = {
        let s = get(&c, &t, &format!("/rest/db/status?folder={q}")).await.map_err(failed("读取文件夹状态"))?;
        // remoteSequence 是对象，serde_json 默认按键排序输出，同样的内容拼出来一样
        format!("{}|{}", s["sequence"], s["remoteSequence"])
    };
    let ignores = get(&c, &t, &format!("/rest/db/ignores?folder={q}")).await.map_err(failed("读取忽略规则"))?;
    let ignored = literal_ignores(&ignores["ignore"]);
    let hit = |key: &str| cache().lock().unwrap().get(&id).filter(|e| e.key == key).map(|e| e.files.clone());
    let files = match hit(&key) {
        Some(files) => files,
        None => {
            let _guard = busy().lock().await;
            match hit(&key) {
                Some(files) => files,
                None => {
                    let started = Instant::now();
                    let tree = get(&c, &t, &format!("/rest/db/browse?folder={q}")).await.map_err(failed("读取文件列表"))?;
                    let files = collect(&tree, TIERS[0]);
                    log::info("folders", "large-files", json!({ "id": id, "files": files.len(), "ms": started.elapsed().as_millis() as u64 }));
                    cache().lock().unwrap().insert(id.clone(), Cached { key, files: files.clone() });
                    files
                }
            }
        }
    };
    // 字面规则只用来挑出“可能被忽略”的，再逐个问 Syncthing 本机是不是真忽略了：
    // 规则里可能有排在前面的 `!` 把它重新包含进来（Game Lab 就是这样，2026-11-18 实测筛错过）
    let mut kept = Vec::with_capacity(files.len());
    let mut checked = 0;
    for f in files {
        if !is_ignored(&f.path, &ignored) {
            kept.push(f);
            continue;
        }
        checked += 1;
        if checked > VERIFY_LIMIT {
            continue;
        }
        let path = format!("/rest/db/file?folder={q}&file={}", urlencode(&f.path));
        // 本机没有这个文件的记录（从没同步过来），按规则算忽略
        if let Ok(v) = get(&c, &t, &path).await {
            if v["local"]["ignored"].as_bool() == Some(false) && v["local"]["deleted"].as_bool() != Some(true) && !v["local"].is_null() {
                kept.push(f);
            }
        }
    }
    Ok(summarize(kept))
}

/// 把一个文件加进忽略规则，返回保存后的全文；已经有这一行就不重复加
pub async fn ignore_file(app: &AppHandle, id: String, path: String) -> Result<String, String> {
    let line = ignore_line(&path);
    let text = crate::manage::folder_ignores(app, id.clone()).await?;
    if text.lines().any(|l| l.trim() == line) {
        return Ok(text);
    }
    let next = if text.trim().is_empty() { line } else { format!("{}\n{line}", text.trim_end()) };
    crate::manage::set_folder_ignores(app, id, next.clone()).await?;
    Ok(next)
}

/// 撤销“加入忽略”：删掉这个文件对应的那一行，别的规则（包括期间手动改的）不动；返回保存后的全文
pub async fn unignore_file(app: &AppHandle, id: String, path: String) -> Result<String, String> {
    let line = ignore_line(&path);
    let text = crate::manage::folder_ignores(app, id.clone()).await?;
    if !text.lines().any(|l| l.trim() == line) {
        return Ok(text);
    }
    let next = text.lines().filter(|l| l.trim() != line).collect::<Vec<_>>().join("\n");
    crate::manage::set_folder_ignores(app, id, next.clone()).await?;
    Ok(next)
}

/// 树里不小于 min 的文件，从大到小
pub fn collect(tree: &Value, min: u64) -> Vec<LargeFile> {
    fn walk(nodes: &Value, prefix: &str, min: u64, out: &mut Vec<LargeFile>) {
        for n in nodes.as_array().into_iter().flatten() {
            let name = n["name"].as_str().unwrap_or_default();
            let path = if prefix.is_empty() { name.to_string() } else { format!("{prefix}/{name}") };
            if n["type"].as_str() == Some("FILE_INFO_TYPE_DIRECTORY") {
                walk(&n["children"], &path, min, out);
            } else if n["type"].as_str() == Some("FILE_INFO_TYPE_FILE") {
                let size = n["size"].as_u64().unwrap_or(0);
                if size >= min {
                    out.push(LargeFile { path, size });
                }
            }
        }
    }
    let mut out = vec![];
    walk(tree, "", min, &mut out);
    out.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.path.cmp(&b.path)));
    out
}

pub fn summarize(files: Vec<LargeFile>) -> LargeFiles {
    let tiers = TIERS
        .iter()
        .map(|&min| {
            let hit = files.iter().filter(|f| f.size >= min);
            Tier { min, count: hit.clone().count() as u32, bytes: hit.map(|f| f.size).sum() }
        })
        .collect();
    LargeFiles { tiers, files: files.into_iter().take(LIST_LIMIT).collect() }
}

/// 写进 .stignore 的一行：从根目录锚定、通配符转义，只忽略这一个文件
pub fn ignore_line(path: &str) -> String {
    let mut out = String::from("/");
    for ch in path.chars() {
        if matches!(ch, '\\' | '*' | '?' | '[' | ']' | '{' | '}') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// 忽略规则里能按字面理解的那些（从根目录锚定、没有通配符，比如“加入忽略”写的）
/// Syncthing 的索引是所有设备的合集，本机忽略了、别的设备还有的文件仍在里面，要筛掉；
/// 这里只做初筛，最后以 Syncthing 对每个文件的判定为准。带通配符的规则不匹配
pub fn literal_ignores(lines: &Value) -> Vec<String> {
    lines
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|line| {
            let mut s = line.trim();
            while let Some(rest) = s.strip_prefix("(?d)").or_else(|| s.strip_prefix("(?i)")) {
                s = rest;
            }
            // “//” 开头是注释
            if s.starts_with("//") {
                return None;
            }
            let s = s.strip_prefix('/')?;
            let mut out = String::new();
            let mut chars = s.chars();
            while let Some(ch) = chars.next() {
                match ch {
                    '\\' => out.push(chars.next()?),
                    '*' | '?' | '[' | ']' | '{' | '}' => return None,
                    _ => out.push(ch),
                }
            }
            let out = out.trim_end_matches('/').to_string();
            (!out.is_empty()).then_some(out)
        })
        .collect()
}

/// macOS 上忽略规则不分大小写
fn is_ignored(path: &str, ignored: &[String]) -> bool {
    let path = path.to_lowercase();
    ignored.iter().any(|p| {
        let p = p.to_lowercase();
        path == p || path.starts_with(&format!("{p}/"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn collects_and_ranks() {
        let tree = json!([
            { "name": "a", "type": "FILE_INFO_TYPE_DIRECTORY", "size": 0, "children": [
                { "name": "big.bin", "type": "FILE_INFO_TYPE_FILE", "size": 200u64 << 20 },
                { "name": "small.txt", "type": "FILE_INFO_TYPE_FILE", "size": 10 },
            ]},
            { "name": "mid.mov", "type": "FILE_INFO_TYPE_FILE", "size": 20u64 << 20 },
            { "name": "link", "type": "FILE_INFO_TYPE_SYMLINK", "size": 50u64 << 20 },
        ]);
        let files = collect(&tree, TIERS[0]);
        assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["a/big.bin", "mid.mov"]);
        let s = summarize(files);
        assert_eq!(s.tiers.iter().map(|t| t.count).collect::<Vec<_>>(), [2, 2, 1, 0]);
        assert_eq!(s.tiers[2].bytes, 200 << 20);
    }
    #[test]
    fn ignore_lines_round_trip() {
        let line = ignore_line("素材/原片 [final]*.mov");
        assert_eq!(line, "/素材/原片 \\[final\\]\\*.mov");
        let ignored = literal_ignores(&json!([line, "(?d).DS_Store", "*.log", "/node_modules", "// 注释"]));
        assert_eq!(ignored, ["素材/原片 [final]*.mov", "node_modules"]);
        assert!(is_ignored("素材/原片 [final]*.mov", &ignored));
        assert!(is_ignored("Node_Modules/x/y.bin", &ignored));
        assert!(!is_ignored("素材/原片.mov", &ignored));
    }
}
