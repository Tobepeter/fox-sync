//! 菜单栏：Syncthing 状态、打开主窗口、设置和退出
use crate::{syncthing::Syncthing, AppState};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

const ID: &str = "main";

// 菜单栏图标：两道同步箭头；Syncthing 不可用时箭头变淡并叠一道斜杠。系统按 18pt 显示并随菜单栏深浅色反色，源文件在 icons/tray/*.svg
fn icon(ok: bool) -> Image<'static> {
    let bytes: &[u8] = if ok {
        include_bytes!("../icons/tray/synced.png")
    } else {
        include_bytes!("../icons/tray/offline.png")
    };
    Image::from_bytes(bytes).expect("菜单栏图标").to_owned()
}

/// 状态文字，菜单栏和提示共用
pub fn status_label(s: &Syncthing) -> String {
    match s.state.as_str() {
        "ok" => {
            let others: Vec<_> = s.devices.iter().filter(|d| !d.me).collect();
            let online = others.iter().filter(|d| d.connected).count();
            let busy = s.folders.iter().filter(|f| matches!(f.state.as_str(), "syncing" | "sync-preparing")).count();
            if busy > 0 {
                format!("正在同步 {busy} 个文件夹 · {online}/{} 台在线", others.len())
            } else {
                format!("已同步 · {online}/{} 台在线", others.len())
            }
        }
        "checking" | "" => "正在检查 Syncthing…".into(),
        "starting" => "正在启动 Syncthing…".into(),
        "occupied" => "同步配置被另一个 Syncthing 锁住了".into(),
        "failed" => "Syncthing 起不来".into(),
        "stopped" => "连不上 Syncthing".into(),
        _ => "Syncthing 出错".into(),
    }
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let status = app.state::<AppState>().syncthing.status.lock().unwrap().clone();
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "status", status_label(&status), false, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "open", "打开 FoxSync", true, None::<&str>)?,
        ],
    )?;
    // 起不来或连不上时多一项「重新启动」
    if matches!(status.state.as_str(), "stopped" | "failed") {
        menu.append(&MenuItem::with_id(app, "launch", "重新启动 Syncthing", true, None::<&str>)?)?;
    }
    menu.append_items(&[
        &MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "quit", "退出 FoxSync", true, None::<&str>)?,
    ])?;
    Ok(menu)
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    TrayIconBuilder::with_id(ID)
        .icon(icon(false))
        .icon_as_template(true)
        .tooltip("FoxSync")
        .menu(&menu(app)?)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => crate::show(app),
            "launch" => crate::syncthing::launch(app),
            "settings" => {
                crate::show(app);
                let _ = app.emit("navigate", "settings");
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// Syncthing 状态变化后刷新菜单和图标
pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(ID) else { return };
    let status = app.state::<AppState>().syncthing.status.lock().unwrap().clone();
    let _ = tray.set_icon(Some(icon(status.state == "ok")));
    let _ = tray.set_icon_as_template(true);
    let _ = tray.set_tooltip(Some(format!("FoxSync · {}", status_label(&status))));
    if let Ok(menu) = menu(app) {
        let _ = tray.set_menu(Some(menu));
    }
}
