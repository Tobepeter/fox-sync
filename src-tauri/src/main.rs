mod crypto;
mod daemon;
mod data;
#[cfg(debug_assertions)]
mod debug;
mod discovery;
mod folders;
mod instance;
mod large;
mod snapshot;
mod log;
mod manage;
mod syncthing;
mod tray;

use data::{Data, Identity, Settings};
use serde::Serialize;
use serde_json::json;
use std::sync::Mutex;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;

pub struct AppState {
    pub data: Mutex<Data>,
    pub syncthing: syncthing::Monitor,
    pub daemon: daemon::Daemon,
    pub hub: discovery::Hub,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
struct Snapshot {
    settings: Settings,
    identity: Identity,
    syncthing: syncthing::Syncthing,
    /// ntfy 频道的连接状态
    channel: discovery::Channel,
    /// 频道里认识的设备，界面按它显示头像和昵称
    peers: Vec<data::Peer>,
    /// 自动共享给频道设备的文件夹
    auto_share: Vec<String>,
    computer_name: String,
    version: String,
    dev: bool,
}

fn snapshot(app: &tauri::AppHandle) -> Snapshot {
    let state = app.state::<AppState>();
    let data = state.data.lock().unwrap().clone();
    let syncthing = state.syncthing.status.lock().unwrap().clone();
    let channel = state.hub.status.lock().unwrap().clone();
    Snapshot {
        settings: data.settings,
        identity: data.identity,
        syncthing,
        channel,
        peers: data.peers,
        auto_share: data.auto_share,
        computer_name: data::computer_name(),
        version: env!("CARGO_PKG_VERSION").into(),
        dev: cfg!(debug_assertions),
    }
}

pub fn notify(app: &tauri::AppHandle) {
    let _ = app.emit("snapshot", snapshot(app));
}

pub fn show(app: &tauri::AppHandle) {
    apply_dock(app, true);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 开发版的 Dock 图标换成方形原图（icons/dev.png），安装版走 icon.icns 由系统显示圆角，
/// 两者在 Dock 里一眼可分。必须在 RunEvent::Ready 之后调用：tauri dev 会在 Ready 时用 icon.icns 覆盖一次
#[cfg(all(debug_assertions, target_os = "macos"))]
fn dev_icon() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;
    let Some(main) = MainThreadMarker::new() else { return };
    let bytes = NSData::with_bytes(include_bytes!("../icons/dev.png"));
    if let Some(image) = NSImage::initWithData(main.alloc(), &bytes) {
        unsafe { NSApplication::sharedApplication(main).setApplicationIconImage(Some(&image)) };
    }
}

fn apply_dock(app: &tauri::AppHandle, window_visible: bool) {
    let mode = app.state::<AppState>().data.lock().unwrap().settings.dock_mode.clone();
    let visible = mode == "always" || (mode == "window" && window_visible);
    let _ = app.set_activation_policy(if visible {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    });
}

fn apply_theme(app: &tauri::AppHandle, theme: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_theme(match theme {
            "dark" => Some(tauri::Theme::Dark),
            "light" => Some(tauri::Theme::Light),
            _ => None,
        });
    }
}

fn save(app: &tauri::AppHandle, update: impl FnOnce(&mut Data)) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut data = state.data.lock().unwrap();
    let mut next = data.clone();
    update(&mut next);
    data::save(&next)?;
    *data = next;
    Ok(())
}

#[tauri::command]
fn get_snapshot(app: tauri::AppHandle) -> Snapshot {
    snapshot(&app)
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, mut settings: Settings) -> Result<(), String> {
    settings.normalize();
    settings.validate()?;
    let previous = app.state::<AppState>().data.lock().unwrap().settings.clone();
    if settings.launch_at_login != previous.launch_at_login {
        if tauri::is_dev() && settings.launch_at_login {
            return Err("开发版不注册登录启动，请在安装版里开启".into());
        }
        let autolaunch = app.autolaunch();
        if settings.launch_at_login {
            autolaunch.enable()
        } else {
            autolaunch.disable()
        }
        .map_err(|e| format!("登录启动设置失败：{e}"))?;
    }
    // 只记改了哪些项，不记值
    let (Ok(serde_json::Value::Object(a)), Ok(serde_json::Value::Object(b))) =
        (serde_json::to_value(&previous), serde_json::to_value(&settings))
    else {
        return Err("设置无法序列化".into());
    };
    let changed: Vec<_> = b.iter().filter(|(k, v)| a.get(*k) != Some(v)).map(|(k, _)| k.clone()).collect();
    if !changed.is_empty() {
        log::info("settings", "changed", json!({ "keys": changed }));
    }
    let avatar_changed = settings.avatar_style != previous.avatar_style;
    save(&app, |d| d.settings = settings.clone())?;
    apply_theme(&app, &settings.theme);
    let visible = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    apply_dock(&app, visible);
    if settings.auto_add != previous.auto_add || settings.auto_join != previous.auto_join || settings.join_root != previous.join_root {
        discovery::poke(&app);
    }
    if avatar_changed {
        discovery::reannounce(&app);
    }
    notify(&app);
    Ok(())
}

/// 改昵称：清洗后保存，并写进本机 Syncthing 的设备名；清空回到电脑名
#[tauri::command]
async fn save_identity(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let name = data::clean_name(&name).unwrap_or_else(data::computer_name);
    save(&app, |d| d.identity.name = name.clone())?;
    log::info("settings", "identity-changed", json!({}));
    notify(&app);
    discovery::reannounce(&app);
    syncthing::set_own_name(&app, &name).await
}

/// 重置设置：恢复默认设置并同步登录启动、Dock；昵称保留
#[tauri::command]
fn reset_settings(app: tauri::AppHandle) -> Result<(), String> {
    save_settings(app, Settings::default())
}

#[tauri::command]
fn refresh_syncthing(app: tauri::AppHandle) {
    app.state::<AppState>().syncthing.refresh();
}

/// 频道断开时手动立即重连
#[tauri::command]
fn reconnect_channel(app: tauri::AppHandle) {
    app.state::<AppState>().hub.restart("manual");
}

#[tauri::command]
fn launch_syncthing(app: tauri::AppHandle) {
    syncthing::launch(&app)
}

/// 别的 Syncthing 占着时，用户选“退出它，由 FoxSync 运行”
#[tauri::command]
async fn syncthing_take_over(app: tauri::AppHandle) -> Result<(), String> {
    let result = daemon::take_over(&app).await;
    app.state::<AppState>().syncthing.refresh();
    notify(&app);
    result
}

/// 在访达里打开一个本地目录
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err("目录不存在".into());
    }
    std::process::Command::new("/usr/bin/open").arg(&path).status().map_err(|e| e.to_string())?;
    Ok(())
}

/// 新建文件夹，或加入别的设备共享过来的文件夹（带上对方的 ID），返回文件夹 ID
#[tauri::command]
async fn create_folder(app: tauri::AppHandle, request: folders::FolderRequest) -> Result<String, String> {
    folders::create(&app, request).await
}

#[tauri::command]
async fn ignore_folder(app: tauri::AppHandle, id: String) -> Result<(), String> {
    folders::ignore_folder(&app, id).await
}

#[tauri::command]
async fn accept_device(app: tauri::AppHandle, id: String) -> Result<(), String> {
    folders::accept_device(&app, id).await
}

#[tauri::command]
async fn ignore_device(app: tauri::AppHandle, id: String) -> Result<(), String> {
    folders::ignore_device(&app, id).await
}

#[tauri::command]
async fn folder_action(app: tauri::AppHandle, id: String, action: String) -> Result<(), String> {
    manage::folder_action(&app, id, action).await
}

#[tauri::command]
async fn update_folder(app: tauri::AppHandle, id: String, patch: manage::FolderPatch) -> Result<(), String> {
    manage::update_folder(&app, id, patch).await
}

#[tauri::command]
async fn remove_folder(app: tauri::AppHandle, id: String) -> Result<(), String> {
    manage::remove_folder(&app, id).await
}

/// 文件夹里的大文件，读 Syncthing 的索引，按序号缓存
#[tauri::command]
async fn large_files(app: tauri::AppHandle, id: String) -> Result<large::LargeFiles, String> {
    large::large_files(&app, id).await
}

#[tauri::command]
async fn ignore_file(app: tauri::AppHandle, id: String, path: String) -> Result<String, String> {
    large::ignore_file(&app, id, path).await
}

#[tauri::command]
async fn unignore_file(app: tauri::AppHandle, id: String, path: String) -> Result<String, String> {
    large::unignore_file(&app, id, path).await
}

#[tauri::command]
async fn folder_ignores(app: tauri::AppHandle, id: String) -> Result<String, String> {
    manage::folder_ignores(&app, id).await
}

#[tauri::command]
async fn set_folder_ignores(app: tauri::AppHandle, id: String, text: String) -> Result<(), String> {
    manage::set_folder_ignores(&app, id, text).await
}

#[tauri::command]
async fn folder_errors(app: tauri::AppHandle, id: String) -> Result<Vec<manage::FileIssue>, String> {
    manage::folder_errors(&app, id).await
}

#[tauri::command]
async fn folder_conflicts(app: tauri::AppHandle, id: String) -> Result<Vec<manage::FileIssue>, String> {
    manage::folder_conflicts(&app, id).await
}

#[tauri::command]
async fn resolve_conflict(app: tauri::AppHandle, id: String, path: String, choice: String) -> Result<String, String> {
    manage::resolve_conflict(&app, id, path, choice).await
}

#[tauri::command]
async fn undo_conflict(app: tauri::AppHandle, id: String, token: String) -> Result<(), String> {
    manage::undo_conflict(&app, id, token).await
}

#[tauri::command]
async fn update_device(app: tauri::AppHandle, id: String, patch: manage::DevicePatch) -> Result<(), String> {
    manage::update_device(&app, id, patch).await
}

#[tauri::command]
async fn add_peer(app: tauri::AppHandle, id: String) -> Result<(), String> {
    manage::add_peer(&app, id).await
}

#[tauri::command]
async fn remove_device(app: tauri::AppHandle, id: String) -> Result<(), String> {
    manage::remove_device(&app, id).await
}

#[tauri::command]
async fn restore_device(app: tauri::AppHandle, id: String) -> Result<(), String> {
    folders::restore_device(&app, id).await
}

#[tauri::command]
async fn restore_ignored(app: tauri::AppHandle, device: String, id: String) -> Result<(), String> {
    manage::restore_ignored(&app, device, id).await
}

#[tauri::command]
async fn folder_members(app: tauri::AppHandle, id: String) -> Result<Vec<manage::Member>, String> {
    manage::folder_members(&app, id).await
}

#[tauri::command]
async fn set_online(app: tauri::AppHandle, online: bool) -> Result<(), String> {
    manage::set_online(&app, online).await
}

#[tauri::command]
async fn share_folder(app: tauri::AppHandle, device: String, folder: String, on: bool) -> Result<(), String> {
    manage::share_folder(&app, device, folder, on).await
}

/// 在访达里选中一个文件（冲突文件、出错文件）
#[tauri::command]
fn reveal_file(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err("文件不存在".into());
    }
    std::process::Command::new("/usr/bin/open").args(["-R", &path]).status().map_err(|e| e.to_string())?;
    Ok(())
}

/// 选目录时看看它在不在、空不空、有没有 .stignore
#[tauri::command]
fn inspect_path(app: tauri::AppHandle, path: String) -> folders::PathInfo {
    let existing = app.state::<AppState>().syncthing.status.lock().unwrap().folders.clone();
    folders::inspect(&path, &existing)
}

/// 系统的选择目录面板；async 命令不在主线程上跑，阻塞等用户选不会卡住界面
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle, start: Option<String>) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app.dialog().file().set_can_create_directories(true);
    if let Some(start) = start.map(|s| folders::expand(&s)) {
        // 默认位置还不存在时从它最近的上级开始
        if let Some(dir) = start.ancestors().find(|p| p.is_dir()) {
            dialog = dialog.set_directory(dir);
        }
    }
    dialog.blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into())
}

/// 清除数据：身份、设置和凭据回到初始状态，日志一并删除；Syncthing 的配置和同步的文件不动
#[tauri::command]
fn wipe_data(app: tauri::AppHandle) -> Result<(), String> {
    if !tauri::is_dev() {
        let _ = app.autolaunch().disable();
    }
    data::wipe()?;
    if let Some(dir) = log::dir() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    let fresh = Data::default();
    data::save(&fresh)?;
    let theme = fresh.settings.theme.clone();
    {
        let state = app.state::<AppState>();
        *state.data.lock().unwrap() = fresh;
        state.syncthing.refresh();
    }
    apply_theme(&app, &theme);
    log::info("data", "wiped", json!({}));
    notify(&app);
    discovery::reannounce(&app);
    Ok(())
}

#[tauri::command]
fn open_logs() -> Result<(), String> {
    let dir = log::dir().ok_or("日志目录不可用")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::process::Command::new("/usr/bin/open").arg(&dir).status().map_err(|e| e.to_string())?;
    Ok(())
}

/// 前端只上报自己的 warn / error，经同一份脱敏写入日志
#[tauri::command]
fn log_client(level: String, event: String, detail: serde_json::Value) {
    let level = if level == "warn" { "warn" } else { "error" };
    log::write(level, "renderer", &event, detail);
}

macro_rules! commands {
    ($($extra:path),*) => {
        tauri::generate_handler![
            get_snapshot,
            save_settings,
            save_identity,
            reset_settings,
            refresh_syncthing,
            launch_syncthing,
            reconnect_channel,
            syncthing_take_over,
            reveal_path,
            create_folder,
            ignore_folder,
            accept_device,
            ignore_device,
            inspect_path,
            pick_folder,
            folder_action,
            update_folder,
            remove_folder,
            folder_ignores,
            set_folder_ignores,
            large_files,
            ignore_file,
            unignore_file,
            folder_errors,
            folder_conflicts,
            resolve_conflict,
            undo_conflict,
            update_device,
            remove_device,
            add_peer,
            share_folder,
            set_online,
            folder_members,
            restore_ignored,
            restore_device,
            reveal_file,
            wipe_data,
            open_logs,
            log_client,
            $($extra),*
        ]
    };
}

fn main() {
    let launched = std::time::Instant::now();
    let hidden = std::env::args().any(|a| a == "--hidden");
    let replaced = instance::take_over();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || show(&handle));
        }))
        .plugin(log::plugin())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ));
    #[cfg(debug_assertions)]
    let builder = builder.invoke_handler(commands![debug::debug_reply, debug::debug_simulate]);
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(commands![]);
    let app = builder
        .setup(move |app| {
            let handle = app.handle().clone();
            log::init(app.path().app_log_dir()?);
            // 沙盒测试的数据另放，免得测试设备混进真实的频道设备列表
            data::init(match daemon::sandbox_home() {
                Some(home) if cfg!(debug_assertions) => home.join("foxsync-data"),
                _ => app.path().app_data_dir()?,
            });
            let data = data::read();
            let _ = data::save(&data);
            let theme = data.settings.theme.clone();
            app.manage(AppState {
                data: Mutex::new(data),
                syncthing: syncthing::Monitor::default(),
                daemon: daemon::Daemon::default(),
                hub: discovery::Hub::default(),
            });
            *app.state::<AppState>().syncthing.status.lock().unwrap() =
                syncthing::Syncthing { state: "checking".into(), ..Default::default() };
            *app.state::<AppState>().daemon.status.lock().unwrap() =
                daemon::DaemonStatus { state: "checking".into(), ..Default::default() };
            instance::claim();
            if let Some(exe) = &replaced {
                log::info("main", "took-over", json!({ "from": exe }));
            }
            log::info(
                "main",
                "launch",
                json!({
                    "version": env!("CARGO_PKG_VERSION"),
                    "build": if cfg!(debug_assertions) { "dev" } else { "release" },
                    "hidden": hidden,
                }),
            );
            apply_theme(&handle, &theme);
            tray::init(&handle)?;
            // 识别占用、结束残留进程可能要等几秒，放到后台
            let ensure = handle.clone();
            std::thread::spawn(move || {
                daemon::ensure(&ensure);
                ensure.state::<AppState>().syncthing.refresh();
            });
            syncthing::start(handle.clone());
            discovery::start(handle.clone());
            manage::start_conflict_watch(handle.clone());
            #[cfg(debug_assertions)]
            debug::start(&handle);
            if let Some(w) = app.get_webview_window("main") {
                let window = w.clone();
                let handle = handle.clone();
                w.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        // 关窗只隐藏，菜单栏继续工作
                        api.prevent_close();
                        let _ = window.hide();
                        apply_dock(&handle, false);
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("FoxSync failed to initialize");
    app.run(move |app, event| match event {
        RunEvent::Ready => {
            // 开发版换成方形图标，和安装版区分
            #[cfg(all(debug_assertions, target_os = "macos"))]
            dev_icon();
            log::info("main", "ready", json!({ "ms": launched.elapsed().as_millis() as u64 }));
            if hidden {
                apply_dock(app, false);
            } else {
                show(app);
            }
        }
        RunEvent::Reopen { .. } => show(app),
        RunEvent::Exit => {
            // 自己拉起的 Syncthing 一起正常关闭，不留残留进程
            daemon::stop(app);
            log::info("main", "exit", json!({}));
        }
        _ => {}
    });
}
