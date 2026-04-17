mod render;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use crate::render::RenderState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .manage(RenderState {
      active_jobs: Arc::new(Mutex::new(HashMap::new())),
    })
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      render::start_render_job,
      render::save_frame,
      render::finish_render_job,
      render::cleanup_render_job
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
