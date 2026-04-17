use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::ShellExt;
use uuid::Uuid;
use base64::{Engine as _, engine::general_purpose};

#[derive(Clone, serde::Serialize)]
pub struct RenderJob {
    pub id: String,
    pub path: PathBuf,
    pub fps: u32,
    pub width: u32,
    pub height: u32,
}

pub struct RenderState {
    pub active_jobs: Arc<Mutex<HashMap<String, RenderJob>>>,
}

#[tauri::command]
pub async fn start_render_job(
    state: State<'_, RenderState>,
    fps: u32,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let job_id = Uuid::new_v4().to_string();
    let temp_dir = std::env::temp_dir().join("mappa-render").join(&job_id);

    fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let job = RenderJob {
        id: job_id.clone(),
        path: temp_dir,
        fps,
        width,
        height,
    };

    let mut jobs = state.active_jobs.lock().unwrap();
    jobs.insert(job_id.clone(), job);

    Ok(job_id)
}

#[tauri::command]
pub async fn save_frame(
    state: State<'_, RenderState>,
    job_id: String,
    frame_index: u32,
    base64_data: String,
) -> Result<(), String> {
    let job = {
        let jobs = state.active_jobs.lock().unwrap();
        jobs.get(&job_id).cloned().ok_or_else(|| format!("Job {} not found", job_id))?
    };

    // Remove potential base64 prefix (e.g., "data:image/png;base64,")
    let clean_data = if let Some(pos) = base64_data.find(",") {
        &base64_data[pos + 1..]
    } else {
        &base64_data
    };

    let bytes = general_purpose::STANDARD
        .decode(clean_data)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    let frame_filename = format!("frame-{:06}.png", frame_index);
    let frame_path = job.path.join(frame_filename);

    fs::write(frame_path, bytes).map_err(|e| format!("Failed to write frame: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn finish_render_job(
    app: AppHandle,
    state: State<'_, RenderState>,
    job_id: String,
    output_path: String,
    encoder: Option<String>,
) -> Result<String, String> {
    let job = {
        let mut jobs = state.active_jobs.lock().unwrap();
        jobs.remove(&job_id).ok_or_else(|| format!("Job {} not found", job_id))?
    };

    let final_output_path = PathBuf::from(output_path);
    if let Some(parent) = final_output_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create output directory: {}", e))?;
    }

    let frames_pattern = job.path.join("frame-%06d.png");
    let encoder_args = build_encoder_args(encoder.as_deref().unwrap_or("libx264"));

    // Invoke FFmpeg sidecar
    let mut args = vec![
        "-y".to_string(),
        "-framerate".to_string(),
        job.fps.to_string(),
        "-i".to_string(),
        frames_pattern.to_string_lossy().into_owned(),
    ];
    args.extend(encoder_args);
    args.extend([
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        final_output_path.to_string_lossy().into_owned(),
    ]);

    let sidecar = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .args(args);

    let output = sidecar
        .output()
        .await
        .map_err(|e| format!("FFmpeg execution failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg error: {}", stderr));
    }

    let _ = fs::remove_dir_all(&job.path);

    Ok(final_output_path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn cleanup_render_job(
    job_id: String,
) -> Result<(), String> {
    let temp_dir = std::env::temp_dir().join("mappa-render").join(&job_id);
    if temp_dir.exists() {
        fs::remove_dir_all(temp_dir).map_err(|e| format!("Failed to cleanup: {}", e))?;
    }
    Ok(())
}

fn build_encoder_args(encoder: &str) -> Vec<String> {
    match encoder {
        "h264_nvenc" => vec![
            "-c:v".into(),
            "h264_nvenc".into(),
            "-preset".into(),
            "p5".into(),
            "-cq".into(),
            "19".into(),
            "-b:v".into(),
            "0".into(),
        ],
        "h264_qsv" => vec![
            "-c:v".into(),
            "h264_qsv".into(),
            "-global_quality".into(),
            "20".into(),
        ],
        "h264_amf" => vec![
            "-c:v".into(),
            "h264_amf".into(),
            "-quality".into(),
            "quality".into(),
        ],
        "libx264" | _ => vec![
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "slow".into(),
            "-crf".into(),
            "18".into(),
        ],
    }
}
