//! 处理冲突前给要动的文件留一份快照，几秒内可撤销；撤销时把快照原样放回原处，期间有没有变化都以快照为准（tobe 2026-11-18 定）
//! 快照放在文件夹自己的 `.stversions/.fox-sync-undo/<token>/` 下：
//! - 和文件在同一个磁盘，macOS 上 `fs::copy` 是 APFS 克隆，1 GB 也是瞬间完成、不额外占空间，修改时间保留（实测）
//! - `.stversions` 是 Syncthing 的内部目录，永远不同步
//!
//! 撤销时直接把快照改名回去，也是瞬间；过一分钟没撤销就删掉，后台每分钟再扫一遍清掉上次运行留下的（两分钟前的）
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};

const DIR: &str = ".stversions/.fox-sync-undo";
/// 界面上撤销只给 5 秒，这里多留一些余量
const KEEP: Duration = Duration::from_secs(60);

struct Entry {
    root: PathBuf,
    /// 目标路径，和它的快照；目标原来不存在时是 None，撤销时删掉它
    files: Vec<(PathBuf, Option<PathBuf>)>,
}

fn entries() -> &'static Mutex<HashMap<String, Entry>> {
    static MAP: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    MAP.get_or_init(Default::default)
}

/// 给这些文件留快照，返回撤销用的 token；`targets` 是绝对路径，都在 `root` 里
pub fn take(root: &Path, targets: &[PathBuf]) -> Result<String, String> {
    let token = format!("{:x}", rand_token());
    let dir = root.join(DIR).join(&token);
    std::fs::create_dir_all(&dir).map_err(|e| format!("留不了撤销用的快照：{e}"))?;
    let mut files = vec![];
    for (i, target) in targets.iter().enumerate() {
        if !target.exists() {
            files.push((target.clone(), None));
            continue;
        }
        let snap = dir.join(i.to_string());
        if let Err(e) = std::fs::copy(target, &snap) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(format!("留不了撤销用的快照：{e}"));
        }
        files.push((target.clone(), Some(snap)));
    }
    entries().lock().unwrap().insert(token.clone(), Entry { root: root.to_path_buf(), files });
    let t = token.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(KEEP).await;
        discard(&t);
    });
    Ok(token)
}

/// 撤销：每个文件放回快照里的样子（原来不存在的删掉），不比对当前内容
pub fn restore(token: &str) -> Result<PathBuf, String> {
    let entry = entries().lock().unwrap().remove(token).ok_or("已经过了撤销时间")?;
    let mut failed = None;
    for (target, snap) in &entry.files {
        let result = match snap {
            Some(snap) => target
                .parent()
                .map_or(Ok(()), std::fs::create_dir_all)
                .and_then(|_| std::fs::rename(snap, target)),
            None if target.exists() => std::fs::remove_file(target),
            None => Ok(()),
        };
        if let Err(e) = result {
            failed.get_or_insert(e.to_string());
        }
    }
    cleanup(&entry.root, token);
    match failed {
        Some(e) => Err(format!("撤销没有完全成功：{e}")),
        None => Ok(entry.root),
    }
}

fn discard(token: &str) {
    if let Some(entry) = entries().lock().unwrap().remove(token) {
        cleanup(&entry.root, token);
    }
}

fn cleanup(root: &Path, token: &str) {
    let _ = std::fs::remove_dir_all(root.join(DIR).join(token));
    remove_empty(root);
}

/// 快照目录空了就删；`.stversions` 也空了一并删（多半是为快照新建的，开了版本保留时 Syncthing 用到会自己再建）。remove_dir 只删空目录
fn remove_empty(root: &Path) {
    if std::fs::remove_dir(root.join(DIR)).is_ok() {
        let _ = std::fs::remove_dir(root.join(".stversions"));
    }
}

/// 清掉这个文件夹里上次运行没来得及删的快照：不在内存里、而且是两分钟前建的
/// （刚建好、还没登记进内存的那一瞬间不能删）
pub fn sweep(root: &Path) {
    let Ok(list) = std::fs::read_dir(root.join(DIR)) else { return };
    let live: Vec<String> = entries().lock().unwrap().keys().cloned().collect();
    for e in list.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > 2 * KEEP);
        if old && !live.contains(&name) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
    remove_empty(root);
}

fn rand_token() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restores_snapshot_over_changes() {
        let root = std::env::temp_dir().join(format!("fox-sync-snap-{:x}", rand_token()));
        std::fs::create_dir_all(root.join("a")).unwrap();
        let copy = root.join("a/x.sync-conflict-20260101-000000-ABCDEFG.txt");
        let original = root.join("a/x.txt");
        std::fs::write(&copy, "副本").unwrap();
        std::fs::write(&original, "原文件").unwrap();
        let token = take(&root, &[original.clone(), copy.clone()]).unwrap();
        // 模拟“用这份”：原文件没了，副本改名成原文件；期间原文件又被改了
        std::fs::remove_file(&original).unwrap();
        std::fs::rename(&copy, &original).unwrap();
        std::fs::write(&original, "期间又改了").unwrap();
        restore(&token).unwrap();
        assert_eq!(std::fs::read_to_string(&original).unwrap(), "原文件");
        assert_eq!(std::fs::read_to_string(&copy).unwrap(), "副本");
        // 快照目录和为它新建的 .stversions 都清掉了
        assert!(!root.join(".stversions").exists());
        assert!(restore(&token).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
