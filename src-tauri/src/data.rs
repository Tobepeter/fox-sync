//! 业务数据：data.json（设置、身份、频道里认识的设备）
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::OnceLock};

pub const NAME_LIMIT: usize = 16;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Settings {
    /// window：主窗口打开时显示；always；never
    pub dock_mode: String,
    pub theme: String,
    /// 头像：name 显示昵称文字，其余是按设备 ID 生成的预设风格；首次随机选一套预设
    pub avatar_style: String,
    pub launch_at_login: bool,
    /// 频道里发现新的 FoxSync 时自动加进 Syncthing；关掉后在设备页手动添加
    /// 每台只自动加一次，之后加不加、删不删以 Syncthing 的设备列表为准
    #[serde(alias = "discovery")]
    pub auto_add: bool,
    /// 频道设备共享来的文件夹自动加入，不经过“可加入”
    pub auto_join: bool,
    /// 自动加入、手动加入的默认存放位置，下面按文件夹名建目录
    pub join_root: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            dock_mode: "window".into(),
            theme: "system".into(),
            avatar_style: random_style(),
            launch_at_login: false,
            auto_add: true,
            auto_join: true,
            join_root: "~/FoxSync".into(),
        }
    }
}
/// DiceBear 头像风格，和前端 src/lib/avatar-styles.ts 一致；前 6 套是 CC0 拟人风格，首次从中随机
pub const AVATAR_STYLES: [&str; 30] = [
    "lorelei", "notionists", "openPeeps", "loreleiNeutral", "notionistsNeutral", "thumbs",
    "adventurer", "adventurerNeutral", "avataaars", "avataaarsNeutral", "bigEars", "bigEarsNeutral",
    "bigSmile", "micah", "miniavs", "personas", "dylan", "toonHead", "funEmoji", "croodles",
    "croodlesNeutral", "bottts", "botttsNeutral", "pixelArt", "pixelArtNeutral", "glass", "icons",
    "identicon", "rings", "shapes",
];
const HUMAN_STYLES: usize = 6;

/// 随机选一套预设头像风格
pub fn random_style() -> String {
    AVATAR_STYLES[rand::random::<usize>() % HUMAN_STYLES].to_string()
}

/// 电脑名（系统设置 → 通用 → 关于本机 → 名称），昵称的默认值；几台机器登录名常常一样，电脑名才分得开
pub fn computer_name() -> String {
    std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .and_then(|o| clean_name(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_else(|| "Mac".into())
}

/// 昵称清洗：只留各国文字、数字、空格和 - _ . ·，合并空白，最多 16 个字；清洗后为空返回 None
pub fn clean_name(input: &str) -> Option<String> {
    let kept: String = input
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .filter(|c| c.is_alphanumeric() || " -_.·".contains(*c))
        .collect();
    let name: String = kept.split(' ').filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
    let name: String = name.chars().take(NAME_LIMIT).collect::<String>().trim().to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

impl Settings {
    pub fn normalize(&mut self) {
        self.join_root = self.join_root.trim().trim_end_matches('/').to_string();
        if self.join_root.is_empty() {
            self.join_root = "~/FoxSync".into();
        }
        if self.avatar_style != "name" && !AVATAR_STYLES.contains(&self.avatar_style.as_str()) {
            self.avatar_style = random_style();
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        if !matches!(self.dock_mode.as_str(), "window" | "always" | "never") {
            return Err("未知的 Dock 显示方式".into());
        }
        if self.avatar_style != "name" && !AVATAR_STYLES.contains(&self.avatar_style.as_str()) {
            return Err("未知的头像风格".into());
        }
        if !(self.join_root.starts_with('/') || self.join_root.starts_with("~/")) {
            return Err("存放位置要是绝对路径，或以 ~/ 开头".into());
        }
        if !matches!(self.theme.as_str(), "system" | "light" | "dark") {
            return Err("未知的外观".into());
        }
        Ok(())
    }
}

/// FoxSync 自己的身份，和 Syncthing 设备 ID 分开：Syncthing 重装后这里不变，别的机器按它认回来
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Identity {
    /// 首次启动随机生成，清除数据后重新生成
    pub id: String,
    pub name: String,
}
impl Identity {
    pub fn fresh() -> Self {
        Self {
            id: uuid::Uuid::new_v4().simple().to_string()[..12].to_string(),
            name: computer_name(),
        }
    }
}

/// 频道里认识的另一台 FoxSync，相当于通讯录；只增不删，Syncthing 重装后按 FoxSync ID 认回来
/// 配没配对不记在这里，看本机 Syncthing 的设备列表
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Peer {
    /// 对方的 FoxSync ID
    pub id: String,
    pub name: String,
    pub avatar: String,
    pub syncthing_id: String,
    /// 对方以前用过的 Syncthing 设备 ID，等着从本机 Syncthing 里换掉
    #[cfg_attr(test, ts(skip))]
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub replaced: Vec<String>,
    /// 最后一次收到它的消息，秒
    pub seen: i64,
    /// 自动添加已经处理过：自动加过一次，或用户自己添加、接受、移除过；之后不再自动加
    #[serde(alias = "removed")]
    pub settled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Data {
    pub settings: Settings,
    pub identity: Identity,
    pub peers: Vec<Peer>,
    /// 自动共享给频道里所有设备的文件夹 ID，新设备配对后也加进去
    pub auto_share: Vec<String>,
    /// ntfy 补收游标：最后处理的消息 ID
    pub cursor: Option<String>,
}
impl Default for Data {
    fn default() -> Self {
        Self { settings: Settings::default(), identity: Identity::fresh(), peers: vec![], auto_share: vec![], cursor: None }
    }
}

static DIR: OnceLock<PathBuf> = OnceLock::new();
pub fn init(dir: PathBuf) {
    let _ = DIR.set(dir);
}
fn path(name: &str) -> Option<PathBuf> {
    DIR.get().map(|d| d.join(name))
}

pub fn read() -> Data {
    let Some(path) = path("data.json") else {
        return Data::default();
    };
    match fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Data>(&text) {
            Ok(mut data) => {
                data.settings.normalize();
                if data.identity.id.is_empty() {
                    data.identity = Identity::fresh();
                }
                if data.identity.name.trim().is_empty() {
                    data.identity.name = computer_name();
                }
                data
            }
            Err(e) => {
                // 坏文件留底，避免覆盖后无从排查
                let _ = fs::rename(&path, path.with_extension("broken.json"));
                crate::log::error("data", "parse-failed", serde_json::json!({ "error": e.to_string() }));
                Data::default()
            }
        },
        Err(_) => Data::default(),
    }
}

fn write_private(name: &str, text: &str) -> Result<(), String> {
    let path = path(name).ok_or("数据目录不可用")?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("tmp");
    {
        use std::io::Write;
        let mut options = fs::OpenOptions::new();
        options.create(true).write(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
        file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub fn save(data: &Data) -> Result<(), String> {
    write_private("data.json", &serde_json::to_string_pretty(data).map_err(|e| e.to_string())?)
}

/// 清除数据：删掉业务数据，身份下次启动重新生成；不碰 Syncthing 自己的配置和同步的文件
/// secrets.json 是早期版本存手填 API key 的，现在不用了，一并删掉
pub fn wipe() -> Result<(), String> {
    for name in ["data.json", "secrets.json", "data.broken.json"] {
        if let Some(p) = path(name) {
            if p.exists() {
                fs::remove_file(&p).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_fields_still_read() {
        // 旧版的 discovery（频道开关）读成自动添加，removed（移除过）读成已处理
        let s: Settings = serde_json::from_str(r#"{"discovery":false}"#).unwrap();
        assert!(!s.auto_add);
        let p: Peer = serde_json::from_str(r#"{"id":"a","removed":true}"#).unwrap();
        assert!(p.settled);
        assert!(Settings::default().auto_add);
    }
    #[test]
    fn names_are_cleaned_and_capped() {
        assert_eq!(clean_name("  tobe-m4  "), Some("tobe-m4".into()));
        assert_eq!(clean_name("  "), None);
        assert_eq!(clean_name("<script>小\n狐"), Some("script小 狐".into()));
        assert_eq!(clean_name("a\u{200b}b🦊c"), Some("abc".into()));
        assert_eq!(clean_name("我的名字特别特别特别特别特别特别长").unwrap().chars().count(), NAME_LIMIT);
    }
    #[test]
    fn identity_is_short_random_with_computer_name() {
        let a = Identity::fresh();
        assert_eq!(a.id.len(), 12);
        assert_ne!(a.id, Identity::fresh().id);
        assert!(!a.name.is_empty());
    }
    #[test]
    fn settings_validate() {
        let mut s = Settings::default();
        assert!(s.validate().is_ok());
        s.theme = "neon".into();
        assert!(s.validate().is_err());
    }
}
