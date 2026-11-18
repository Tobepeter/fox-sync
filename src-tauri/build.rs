fn main() {
    // 频道配置在构建时由 .env 注入（option_env!），值变了要重新编译
    for name in ["FOX_SYNC_DEFAULT_SERVER", "FOX_SYNC_DEFAULT_TOPIC", "FOX_SYNC_DEFAULT_TOKEN", "FOX_SYNC_DEFAULT_KEY"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    tauri_build::build()
}
