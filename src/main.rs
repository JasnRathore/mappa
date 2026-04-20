mod animation;
mod components;
mod engine;
mod geocoding;
mod map_plugin;
mod project_manager;
mod theme;
mod transitions;
mod ui_graph;

use components::button::keyframe_button;
use egui::Panel;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

struct ProjectPreset {
    label: &'static str,
    resolution: [u32; 2],
    fps: f32,
}

const PROJECT_PRESETS: &[ProjectPreset] = &[
    ProjectPreset {
        label: "HD 1080p (30 FPS)",
        resolution: [1920, 1080],
        fps: 30.0,
    },
    ProjectPreset {
        label: "HD 1080p (60 FPS)",
        resolution: [1920, 1080],
        fps: 60.0,
    },
    ProjectPreset {
        label: "4K UHD (30 FPS)",
        resolution: [3840, 2160],
        fps: 30.0,
    },
    ProjectPreset {
        label: "Vertical Social (30 FPS)",
        resolution: [1080, 1920],
        fps: 30.0,
    },
    ProjectPreset {
        label: "Vertical Social (60 FPS)",
        resolution: [1080, 1920],
        fps: 60.0,
    },
    ProjectPreset {
        label: "Custom",
        resolution: [1920, 1080],
        fps: 30.0,
    },
];

fn main() -> Result<(), eframe::Error> {
    let args: Vec<String> = std::env::args().collect();
    let controller = AppController {
        command: Arc::new(Mutex::new(None)),
    };

    if let Some(project_path) = args.iter().position(|a| a == "--project").and_then(|i| args.get(i + 1)) {
        run_editor(controller.clone(), Some(std::path::PathBuf::from(project_path)));
    } else if args.contains(&"--editor".to_string()) {
        run_editor(controller.clone(), None);
    } else {
        run_project_manager(controller.clone());
    }

    Ok(())
}

fn run_project_manager(controller: AppController) {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1000.0, 700.0])
            .with_title("Project Manager"),
        ..Default::default()
    };

    let _ = eframe::run_native(
        "Project Manager",
        options,
        Box::new(|cc| {
            Ok(Box::new(MyApp::new(
                cc,
                controller.clone(),
                AppState::ProjectManager,
                project_manager::ProjectSettings::default(),
            )))
        }),
    );
}

fn run_editor(controller: AppController, project_path: Option<std::path::PathBuf>) {
    let settings = if let Some(path) = &project_path {
        let settings_path = path.join("project.json");
        if settings_path.exists() {
            let s = std::fs::read_to_string(settings_path).unwrap_or_default();
            serde_json::from_str::<project_manager::ProjectSettings>(&s).unwrap_or_else(|_| project_manager::ProjectSettings {
                name: path.file_name().and_then(|n| n.to_str()).unwrap_or("Editor").to_string(),
                ..Default::default()
            })
        } else {
            project_manager::ProjectSettings {
                name: path.file_name().and_then(|n| n.to_str()).unwrap_or("Editor").to_string(),
                ..Default::default()
            }
        }
    } else {
        project_manager::ProjectSettings::default()
    };

    let title = format!("Mappar - {}", settings.name);
    // Aspect ratio: resolution[0] / resolution[1]
    // We want a window that is roughly 1200px wide.
    let aspect = settings.resolution[0] as f32 / settings.resolution[1] as f32;
    let width = 1200.0;
    let height = width / aspect;

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([width, height])
            .with_title(&title),
        ..Default::default()
    };

    let _ = eframe::run_native(
        &title,
        options,
        Box::new(move |cc| {
            Ok(Box::new(MyApp::new(
                cc,
                controller.clone(),
                AppState::Editor,
                settings,
            )))
        }),
    );
}

#[derive(PartialEq, Clone, Copy)]
enum InspectorTab {
    Camera,
    Inspector,
}

#[derive(Clone)]
struct RenderJob {
    name: String,
    status: String,
    progress: f32,
}

#[derive(Clone)]
struct RenderSettings {
    format: String,
    codec: String,
    resolution: [u32; 2],
    fps: f32,
    custom_name: String,
}

struct EditorState {
    map: engine::MapEngine,
    graph_editor: ui_graph::GraphEditor,
    timeline: components::timeline::Timeline,
    show_graph: bool,
    search_query: String,
    search_results: Arc<Mutex<Vec<crate::geocoding::LocationResult>>>,
    is_searching: Arc<AtomicBool>,
    dragging_location: Option<crate::geocoding::LocationResult>,
    selected_clip: Option<(usize, usize)>,
    inspector_tab: InspectorTab,
    selected_clip_channel: Option<String>,
    show_render_window: bool,
    settings: project_manager::ProjectSettings,
    canvas_zoom: f32,
    canvas_offset: egui::Vec2,
    canvas_fit_to_screen: bool,
    render_settings: RenderSettings,
    render_queue: Vec<RenderJob>,
}

impl EditorState {
    fn render_view(&mut self, ui: &mut egui::Ui, is_preview: bool) {
        let available_rect = ui.max_rect();
        
        // --- 1. ASPECT CALCULATION ---
        let proj_w = self.settings.resolution[0] as f32;
        let proj_h = self.settings.resolution[1] as f32;
        let aspect = proj_w / proj_h;

        let canvas_rect = if is_preview {
            // Preview mode: use workspace zoom/offset
            self.handle_canvas_input(ui, available_rect);

            if self.canvas_fit_to_screen {
                let padding = 40.0;
                let fit_w = available_rect.width() - padding * 2.0;
                let fit_h = available_rect.height() - padding * 2.0;

                let scale_w = fit_w / proj_w;
                let scale_h = fit_h / proj_h;
                self.canvas_zoom = scale_w.min(scale_h).min(1.0);
                self.canvas_offset = egui::Vec2::ZERO;
            }

            let canvas_w = proj_w * self.canvas_zoom;
            let canvas_h = proj_h * self.canvas_zoom;

            egui::Rect::from_center_size(
                available_rect.center() + self.canvas_offset,
                egui::vec2(canvas_w, canvas_h),
            )
        } else {
            // Clean render mode: always fit to window, no offset
            let fit_w = available_rect.width();
            let fit_h = available_rect.height();

            let scale_w = fit_w / proj_w;
            let scale_h = fit_h / proj_h;
            let scale = scale_w.min(scale_h);

            egui::Rect::from_center_size(
                available_rect.center(),
                egui::vec2(proj_w * scale, proj_h * scale),
            )
        };

        // --- 2. DRAW BACKGROUND ---
        let bg_color = if is_preview { crate::theme::BG_PANEL } else { egui::Color32::BLACK };
        ui.painter().rect_filled(available_rect, 0.0, bg_color);

        // --- 3. DRAW CANVAS DECORATIONS (Preview ONLY) ---
        if is_preview {
            let shadow_rect = canvas_rect.expand(4.0);
            ui.painter().rect_filled(shadow_rect, 0.0, egui::Color32::from_black_alpha(40));
            ui.painter().rect_stroke(canvas_rect, 0.0, egui::Stroke::new(1.0, egui::Color32::from_gray(80)), egui::StrokeKind::Outside);
        }

        // --- 4. DRAW CHECKERBOARD (Always for visual accuracy) ---
        self.draw_checkerboard(ui, canvas_rect);

        // --- 5. RENDER CONTENT ---
        self.render_content(ui, canvas_rect);

        // --- 6. DRAW HUD (Preview ONLY) ---
        if is_preview {
            self.draw_canvas_hud(ui, canvas_rect);
        }
    }

    fn render_content(&mut self, ui: &mut egui::Ui, rect: egui::Rect) {
        let mut canvas_ui = ui.new_child(egui::UiBuilder::new().max_rect(rect));
        
        self.map.ui(&mut canvas_ui);

        // Effects (Dissolve / Wipe) relative to rect
        let dissolve = self
            .map
            .parameter_cache
            .get("Dissolve")
            .map(|c| c.value.as_float())
            .unwrap_or(0.0);

        let wipe = self
            .map
            .parameter_cache
            .get("Wipe")
            .map(|c| c.value.as_float())
            .unwrap_or(1.0);

        if wipe < 1.0 {
            let wipe_width = rect.width() * (1.0 - wipe as f32);
            let wipe_overlay = egui::Rect::from_min_max(
                rect.right_top() - egui::vec2(wipe_width, 0.0),
                rect.right_bottom(),
            );
            canvas_ui.painter().rect_filled(wipe_overlay, 0.0, egui::Color32::BLACK);
        }

        if dissolve > 0.0 {
            canvas_ui.painter().rect_filled(
                rect,
                0.0,
                egui::Color32::BLACK.linear_multiply(dissolve as f32),
            );
        }
    }

    fn handle_canvas_input(&mut self, ui: &egui::Ui, available_rect: egui::Rect) {
        let response = ui.interact(available_rect, ui.id().with("canvas_input"), egui::Sense::click_and_drag());
        
        // Panning: Middle mouse or Space + Left Mouse
        let is_panning = ui.input(|i| i.pointer.button_down(egui::PointerButton::Middle)) ||
                         (ui.input(|i| i.key_down(egui::Key::Space)) && response.dragged());
        
        if is_panning {
            self.canvas_offset += response.drag_delta();
            self.canvas_fit_to_screen = false;
            ui.ctx().set_cursor_icon(egui::CursorIcon::Grabbing);
        }

        // Zooming: Ctrl + Scroll
        let scroll_delta = ui.input(|i| i.smooth_scroll_delta.y);
        if scroll_delta != 0.0 {
            let zoom_factor = (scroll_delta / 200.0).exp();
            let new_zoom = (self.canvas_zoom * zoom_factor).clamp(0.01, 10.0);
            
            if (new_zoom - self.canvas_zoom).abs() > 0.0001 {
                // Adjust offset so we zoom toward the pointer
                if let Some(ptr_pos) = ui.input(|i| i.pointer.hover_pos()) {
                    let ptr_local = ptr_pos - (available_rect.center() + self.canvas_offset);
                    self.canvas_offset -= ptr_local * (new_zoom / self.canvas_zoom - 1.0);
                }
                
                self.canvas_zoom = new_zoom;
                self.canvas_fit_to_screen = false;
            }
        }

        // Reset: 'F' key to fit
        if ui.input(|i| i.key_pressed(egui::Key::F)) {
            self.canvas_fit_to_screen = true;
        }
    }

    fn draw_checkerboard(&self, ui: &egui::Ui, rect: egui::Rect) {
        let painter = ui.painter().with_clip_rect(rect);
        let grid_size = 16.0;
        
        let color1 = egui::Color32::from_gray(25);
        let color2 = egui::Color32::from_gray(35);
        
        let start_x = (rect.min.x / grid_size).floor() as i32;
        let start_y = (rect.min.y / grid_size).floor() as i32;
        let end_x = (rect.max.x / grid_size).ceil() as i32;
        let end_y = (rect.max.y / grid_size).ceil() as i32;

        for x in start_x..end_x {
            for y in start_y..end_y {
                let cell_rect = egui::Rect::from_min_size(
                    egui::pos2(x as f32 * grid_size, y as f32 * grid_size),
                    egui::vec2(grid_size, grid_size),
                );
                
                // Intersect with canvas rect
                let visible_rect = cell_rect.intersect(rect);
                if visible_rect.is_positive() {
                    let color = if (x + y) % 2 == 0 { color1 } else { color2 };
                    painter.rect_filled(visible_rect, 0.0, color);
                }
            }
        }
    }

    fn draw_canvas_hud(&self, ui: &egui::Ui, canvas_rect: egui::Rect) {
        let hud_rect = egui::Rect::from_min_max(
            canvas_rect.left_bottom() + egui::vec2(0.0, 4.0),
            canvas_rect.right_bottom() + egui::vec2(0.0, 24.0)
        );
        
        ui.painter().text(
            hud_rect.left_top(),
            egui::Align2::LEFT_TOP,
            format!(
                "{}% | {}x{} | Press 'F' to Fit",
                (self.canvas_zoom * 100.0) as i32,
                self.settings.resolution[0],
                self.settings.resolution[1]
            ),
            egui::FontId::monospace(10.0),
            egui::Color32::from_gray(120)
        );
    }

    fn ui_render_settings(&mut self, ui: &mut egui::Ui) {
        ui.vertical(|ui| {
            ui.add_space(10.0);
            ui.heading("RENDER SETTINGS");
            ui.add_space(15.0);

            ui.group(|ui| {
                ui.set_width(ui.available_width());
                ui.label(egui::RichText::new("FILE NAME").size(11.0).color(crate::theme::TEXT_MUTED));
                ui.text_edit_singleline(&mut self.render_settings.custom_name);
            });

            ui.add_space(10.0);

            ui.group(|ui| {
                ui.set_width(ui.available_width());
                ui.label(egui::RichText::new("FORMAT & CODEC").size(11.0).color(crate::theme::TEXT_MUTED));
                
                ui.horizontal(|ui| {
                    ui.label("Format:");
                    egui::ComboBox::from_id_salt("fmt")
                        .selected_text(&self.render_settings.format)
                        .show_ui(ui, |ui| {
                            ui.selectable_value(&mut self.render_settings.format, "MP4".to_string(), "MP4");
                            ui.selectable_value(&mut self.render_settings.format, "MOV".to_string(), "MOV");
                            ui.selectable_value(&mut self.render_settings.format, "PNG SEQ".to_string(), "PNG SEQ");
                        });
                });

                ui.horizontal(|ui| {
                    ui.label("Codec:");
                    egui::ComboBox::from_id_salt("codec")
                        .selected_text(&self.render_settings.codec)
                        .show_ui(ui, |ui| {
                            ui.selectable_value(&mut self.render_settings.codec, "H.264".to_string(), "H.264");
                            ui.selectable_value(&mut self.render_settings.codec, "H.265".to_string(), "H.265");
                            ui.selectable_value(&mut self.render_settings.codec, "ProRes 422".to_string(), "ProRes 422");
                        });
                });
            });

            ui.add_space(10.0);

            ui.group(|ui| {
                ui.set_width(ui.available_width());
                ui.label(egui::RichText::new("RESOLUTION & FPS").size(11.0).color(crate::theme::TEXT_MUTED));
                
                ui.horizontal(|ui| {
                    ui.add(egui::DragValue::new(&mut self.render_settings.resolution[0]).speed(1));
                    ui.label("x");
                    ui.add(egui::DragValue::new(&mut self.render_settings.resolution[1]).speed(1));
                });

                ui.horizontal(|ui| {
                    ui.label("FPS:");
                    ui.add(egui::DragValue::new(&mut self.render_settings.fps).speed(0.1));
                });
            });

            ui.with_layout(egui::Layout::bottom_up(egui::Align::Center), |ui| {
                ui.add_space(10.0);
                if ui.add_sized([ui.available_width(), 32.0], 
                    egui::Button::new(egui::RichText::new("ADD TO RENDER QUEUE").strong())
                        .fill(crate::theme::PRIMARY))
                    .clicked() 
                {
                    self.render_queue.push(RenderJob {
                        name: self.render_settings.custom_name.clone(),
                        status: "Ready".to_string(),
                        progress: 0.0,
                    });
                }
            });
        });
    }

    fn ui_render_queue(&mut self, ui: &mut egui::Ui) {
        ui.vertical(|ui| {
            ui.add_space(10.0);
            ui.heading("RENDER QUEUE");
            ui.add_space(15.0);

            egui::ScrollArea::vertical().show(ui, |ui| {
                for (idx, job) in self.render_queue.iter().enumerate() {
                    ui.group(|ui| {
                        ui.set_width(ui.available_width());
                        ui.horizontal(|ui| {
                            ui.vertical(|ui| {
                                ui.label(egui::RichText::new(&job.name).strong());
                                ui.label(egui::RichText::new(&job.status).size(10.0).color(egui::Color32::from_rgb(0, 200, 0)));
                            });
                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                if ui.button("❌").clicked() {
                                    // Handle removal in next loop or with retain
                                }
                            });
                        });
                        
                        if job.progress > 0.0 {
                            ui.add(egui::ProgressBar::new(job.progress).show_percentage());
                        }
                    });
                    ui.add_space(4.0);
                }
            });

            ui.with_layout(egui::Layout::bottom_up(egui::Align::Center), |ui| {
                ui.add_space(10.0);
                if ui.add_sized([ui.available_width(), 40.0], 
                    egui::Button::new(egui::RichText::new("🚀 RENDER ALL").strong())
                        .fill(egui::Color32::from_rgb(0, 120, 0)))
                    .clicked() 
                {
                    // Start render logic
                }
            });
        });
    }
}

#[derive(Clone)]
struct AppController {
    command: Arc<Mutex<Option<AppCommand>>>,
}

#[derive(Clone)]
enum AppCommand {
    OpenEditor(std::path::PathBuf),
    OpenProjectManager,
    CloseSelf,
}

struct MyApp {
    controller: AppController,
    app_state: AppState,

    project_manager: project_manager::ProjectManager,
    editor: EditorState,

    new_project_name: String,
    new_project_fps: f32,
    new_project_resolution: [u32; 2],
    new_project_preset_idx: usize,
    show_new_project_dialog: bool,

    renaming_project_idx: Option<usize>,
    rename_temp_name: String,
    deleting_project_idx: Option<usize>,
}

#[derive(PartialEq, Clone, Copy)]
enum AppState {
    ProjectManager,
    Editor,
}

impl MyApp {
    fn new(
        cc: &eframe::CreationContext<'_>,
        controller: AppController,
        initial_state: AppState,
        settings: project_manager::ProjectSettings,
    ) -> Self {
        let mut fonts = egui::FontDefinitions::default();
        fonts.font_data.insert(
            "dm_sans".to_owned(),
            egui::FontData::from_static(include_bytes!("../assets/DMSans-Variable.ttf")).into(),
        );

        fonts
            .families
            .get_mut(&egui::FontFamily::Proportional)
            .unwrap()
            .push("dm_sans".to_owned());

        // --- Phosphor Regular ---
        fonts.font_data.insert(
            "phosphor_regular".into(),
            egui_phosphor::Variant::Regular.font_data().into(),
        );

        // --- Phosphor Fill ---
        fonts.font_data.insert(
            "phosphor_fill".into(),
            egui_phosphor::Variant::Fill.font_data().into(),
        );

        // 👉 Make phosphor a fallback (not primary)
        fonts
            .families
            .get_mut(&egui::FontFamily::Proportional)
            .unwrap()
            .push("phosphor_regular".into());

        // Separate family for fill icons
        fonts.families.insert(
            egui::FontFamily::Name("phosphor_fill".into()),
            vec!["phosphor_fill".into()],
        );
        cc.egui_ctx.set_fonts(fonts);
        theme::apply(&cc.egui_ctx);

        let mut editor_state = EditorState {
            map: engine::MapEngine::new(cc),
            graph_editor: ui_graph::GraphEditor::new(),
            timeline: components::timeline::Timeline::new(),
            show_graph: false,
            search_query: String::new(),
            search_results: Arc::new(Mutex::new(Vec::new())),
            is_searching: Arc::new(AtomicBool::new(false)),
            dragging_location: None,
            selected_clip: None,
            inspector_tab: InspectorTab::Camera,
            selected_clip_channel: None,
            show_render_window: false,
            settings: settings.clone(),
            canvas_zoom: 1.0,
            canvas_offset: egui::Vec2::ZERO,
            canvas_fit_to_screen: true,
            render_settings: RenderSettings {
                format: "MP4".to_string(),
                codec: "H.264".to_string(),
                resolution: settings.resolution,
                fps: settings.fps,
                custom_name: settings.name.clone(),
            },
            render_queue: vec![
                RenderJob { name: "Job 1".to_string(), status: "Ready".to_string(), progress: 0.0 },
            ],
        };
        editor_state.map.fps = settings.fps;

        Self {
            controller,
            app_state: initial_state,
            project_manager: project_manager::ProjectManager::new(),
            editor: editor_state,
            new_project_name: String::new(),
            new_project_fps: 30.0,
            new_project_resolution: [1920, 1080],
            new_project_preset_idx: 0,
            show_new_project_dialog: false,
            renaming_project_idx: None,
            rename_temp_name: String::new(),
            deleting_project_idx: None,
        }
    }
}

impl eframe::App for MyApp {
    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        match self.app_state {
            AppState::ProjectManager => self.ui_project_manager(ui),
            AppState::Editor => self.ui_editor(ui, frame),
        }
        let ctx = ui.ctx();
        if let Some(cmd) = self.controller.command.lock().unwrap().take() {
            match cmd {
                AppCommand::OpenEditor(path) => {
                    std::process::Command::new(std::env::current_exe().unwrap())
                        .arg("--editor")
                        .arg("--project")
                        .arg(path)
                        .spawn()
                        .unwrap();
                    ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                }

                AppCommand::OpenProjectManager => {
                    std::process::Command::new(std::env::current_exe().unwrap())
                        .arg("--pm")
                        .spawn()
                        .unwrap();
                }

                AppCommand::CloseSelf => {
                    ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                }
            }
        }

        let mut close_requested = false;
        if self.app_state == AppState::Editor && self.editor.show_render_window {
            let res = self.editor.settings.resolution;
            
            // Scaling logic: If resolution is too large for current screen, scale it down
            // but keep the aspect ratio.
            let max_w = 1600.0;
            let max_h = 900.0;
            
            let mut w = res[0] as f32;
            let mut h = res[1] as f32;
            
            if w > max_w || h > max_h {
                let scale_w = max_w / w;
                let scale_h = max_h / h;
                let scale = scale_w.min(scale_h);
                w *= scale;
                h *= scale;
            }

            ctx.show_viewport_immediate(
                egui::ViewportId::from_hash_of("render_window"),
                egui::ViewportBuilder::default()
                    .with_title(format!("Render Window - {}x{}", res[0], res[1]))
                    .with_inner_size([w, h]),
                |ctx, _class| {
                    if ctx.input(|i| i.viewport().close_requested()) {
                        close_requested = true;
                    }
                    
                    // --- RENDER WORKSPACE LAYOUT ---
                    egui::SidePanel::left("render_settings")
                        .resizable(true)
                        .default_width(280.0)
                        .min_width(200.0)
                        .show(ctx, |ui| {
                            self.editor.ui_render_settings(ui);
                        });

                    egui::SidePanel::right("render_queue")
                        .resizable(true)
                        .default_width(240.0)
                        .min_width(180.0)
                        .show(ctx, |ui| {
                            self.editor.ui_render_queue(ui);
                        });

                    egui::CentralPanel::default().show(ctx, |ui| {
                        // The viewer in render window is "clean" but centered in available area
                        self.editor.render_view(ui, false);
                    });
                },
            );
        }
        if close_requested {
            self.editor.show_render_window = false;
        }
    }
}

impl MyApp {
    fn ui_project_manager(&mut self, ui: &mut egui::Ui) {
        egui::CentralPanel::default().show_inside(ui, |ui| {
            if let Some(action) = self.project_manager.ui(ui) {
                match action {
                    project_manager::ProjectAction::Open(project_idx) => {
                        if let Ok(path) = self.project_manager.open_project(project_idx) {
                            *self.controller.command.lock().unwrap() =
                                Some(AppCommand::OpenEditor(path));
                        }
                    }
                    project_manager::ProjectAction::NewProject => {
                        self.show_new_project_dialog = true;
                    }
                    project_manager::ProjectAction::Delete(idx) => {
                        self.deleting_project_idx = Some(idx);
                    }
                    project_manager::ProjectAction::Rename(idx) => {
                        self.renaming_project_idx = Some(idx);
                        self.rename_temp_name = self.project_manager.projects[idx].name.clone();
                    }
                }
            }
        });

        if self.show_new_project_dialog {
            let mut is_open = true;
            let mut close_clicked = false;
            egui::Window::new("NEW PROJECT")
                .open(&mut is_open)
                .resizable(false)
                .collapsible(false)
                .anchor(egui::Align2::CENTER_CENTER, egui::vec2(0.0, 0.0))
                .show(ui.ctx(), |ui| {
                    egui::Frame::NONE
                        .inner_margin(20.0)
                        .show(ui, |ui| {
                            ui.vertical(|ui| {
                                ui.label(egui::RichText::new("PROJECT NAME").size(11.0).color(crate::theme::TEXT_MUTED));
                                ui.add_space(4.0);
                                ui.text_edit_singleline(&mut self.new_project_name);
                                
                                ui.add_space(15.0);

                                ui.label(egui::RichText::new("PRESET").size(11.0).color(crate::theme::TEXT_MUTED));
                                ui.add_space(4.0);
                                let old_preset = self.new_project_preset_idx;
                                egui::ComboBox::from_id_salt("project_preset")
                                    .selected_text(PROJECT_PRESETS[self.new_project_preset_idx].label)
                                    .width(ui.available_width())
                                    .show_ui(ui, |ui| {
                                        for (idx, preset) in PROJECT_PRESETS.iter().enumerate() {
                                            ui.selectable_value(&mut self.new_project_preset_idx, idx, preset.label);
                                        }
                                    });
                                
                                if self.new_project_preset_idx != old_preset && self.new_project_preset_idx < PROJECT_PRESETS.len() - 1 {
                                    // Non-custom preset selected
                                    let p = &PROJECT_PRESETS[self.new_project_preset_idx];
                                    self.new_project_resolution = p.resolution;
                                    self.new_project_fps = p.fps;
                                }

                                ui.add_space(15.0);

                                ui.label(egui::RichText::new("RESOLUTION").size(11.0).color(crate::theme::TEXT_MUTED));
                                ui.add_space(4.0);
                                ui.horizontal(|ui| {
                                    let r_w = ui.add(egui::DragValue::new(&mut self.new_project_resolution[0]).speed(1));
                                    ui.label("x");
                                    let r_h = ui.add(egui::DragValue::new(&mut self.new_project_resolution[1]).speed(1));
                                    
                                    if r_w.changed() || r_h.changed() {
                                        self.new_project_preset_idx = PROJECT_PRESETS.len() - 1; // Custom
                                    }
                                });

                                ui.add_space(15.0);

                                ui.label(egui::RichText::new("FPS").size(11.0).color(crate::theme::TEXT_MUTED));
                                ui.add_space(4.0);
                                if ui.add(egui::DragValue::new(&mut self.new_project_fps).speed(1)).changed() {
                                    self.new_project_preset_idx = PROJECT_PRESETS.len() - 1; // Custom
                                }

                                ui.add_space(25.0);

                                ui.horizontal(|ui| {
                                    let btn_create = ui.add_sized(
                                        [80.0, 24.0],
                                        egui::Button::new(egui::RichText::new("CREATE").strong())
                                            .fill(crate::theme::PRIMARY)
                                            .stroke(egui::Stroke::NONE)
                                    );
                                    if btn_create.clicked() && !self.new_project_name.is_empty() {
                                        if let Ok(path) = self.project_manager.create_project(&self.new_project_name) {
                                            let settings = project_manager::ProjectSettings {
                                                name: self.new_project_name.clone(),
                                                resolution: self.new_project_resolution,
                                                fps: self.new_project_fps,
                                            };
                                            let settings_json = serde_json::to_string_pretty(&settings).unwrap();
                                            let _ = std::fs::write(path.join("project.json"), settings_json);

                                            self.new_project_name.clear();
                                            close_clicked = true;
                                            *self.controller.command.lock().unwrap() = Some(AppCommand::OpenEditor(path));
                                        }
                                    }

                                    if ui.add_sized([80.0, 24.0], egui::Button::new("CANCEL")).clicked() {
                                        self.new_project_name.clear();
                                        close_clicked = true;
                                    }
                                });
                            });
                        });
                });
            if !is_open || close_clicked {
                self.show_new_project_dialog = false;
            }
        }

        if let Some(idx) = self.renaming_project_idx {
            let mut is_open = true;
            let mut close_clicked = false;
            egui::Window::new("RENAME PROJECT")
                .open(&mut is_open)
                .resizable(false)
                .collapsible(false)
                .anchor(egui::Align2::CENTER_CENTER, egui::vec2(0.0, 0.0))
                .show(ui.ctx(), |ui| {
                    egui::Frame::NONE
                        .inner_margin(20.0)
                        .show(ui, |ui| {
                            ui.vertical(|ui| {
                                ui.label(egui::RichText::new("NEW NAME").size(11.0).color(crate::theme::TEXT_MUTED));
                                ui.add_space(4.0);
                                ui.text_edit_singleline(&mut self.rename_temp_name);

                                ui.add_space(20.0);

                                ui.horizontal(|ui| {
                                    let btn_rename = ui.add_sized(
                                        [80.0, 24.0],
                                        egui::Button::new(egui::RichText::new("RENAME").strong())
                                            .fill(crate::theme::PRIMARY)
                                            .stroke(egui::Stroke::NONE)
                                    );
                                    if btn_rename.clicked() && !self.rename_temp_name.is_empty() {
                                        let _ = self.project_manager.rename_project(idx, self.rename_temp_name.clone());
                                        close_clicked = true;
                                    }
                                    if ui.add_sized([80.0, 24.0], egui::Button::new("CANCEL")).clicked() {
                                        close_clicked = true;
                                    }
                                });
                            });
                        });
                });
            if !is_open || close_clicked {
                self.renaming_project_idx = None;
            }
        }

        if let Some(idx) = self.deleting_project_idx {
            let mut is_open = true;
            let mut close_clicked = false;
            let project_name = self.project_manager.projects[idx].name.clone();
            egui::Window::new("DELETE PROJECT")
                .open(&mut is_open)
                .resizable(false)
                .collapsible(false)
                .anchor(egui::Align2::CENTER_CENTER, egui::vec2(0.0, 0.0))
                .show(ui.ctx(), |ui| {
                    egui::Frame::NONE
                        .inner_margin(20.0)
                        .show(ui, |ui| {
                            ui.vertical(|ui| {
                                ui.label(format!("Are you sure you want to delete '{}'?", project_name));
                                ui.label(egui::RichText::new("This action cannot be undone.").size(12.0).color(crate::theme::DESTRUCTIVE));
                                
                                ui.add_space(20.0);

                                ui.horizontal(|ui| {
                                    let btn_delete = ui.add_sized(
                                        [120.0, 24.0],
                                        egui::Button::new(egui::RichText::new("🗑 YES, DELETE").strong())
                                            .fill(crate::theme::DESTRUCTIVE)
                                            .stroke(egui::Stroke::NONE)
                                    );
                                    if btn_delete.clicked() {
                                        let _ = self.project_manager.delete_project(idx);
                                        close_clicked = true;
                                    }
                                    if ui.add_sized([80.0, 24.0], egui::Button::new("CANCEL")).clicked() {
                                        close_clicked = true;
                                    }
                                });
                            });
                        });
                });
            if !is_open || close_clicked {
                self.deleting_project_idx = None;
            }
        }
    }

    fn ui_editor(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let editor = &mut self.editor;

        let ctx = ui.ctx().clone();

        editor.map.update();

        if editor.map.is_playing {
            ctx.request_repaint();
        }

        let mut back_to_projects = false;
        egui::Panel::top("menu_bar").show_inside(ui, |ui| {
            ui.horizontal(|ui| {
                ui.menu_button("File", |ui| {
                    if ui.button("New").clicked() {
                        ui.close();
                    }
                    if ui.button("Open").clicked() {
                        ui.close();
                    }
                    ui.separator();
                    if ui.button("Save").clicked() {
                        ui.close();
                    }
                    ui.separator();
                    if ui.button("Back to Projects").clicked() {
                        back_to_projects = true;
                        ui.close();
                    }
                });
                ui.menu_button("View", |ui| {
                    ui.checkbox(&mut editor.show_graph, "Graph Editor");
                    ui.checkbox(&mut editor.show_render_window, "Render Window");
                });
                if ui.button("Render").clicked() {
                    editor.show_render_window = true;
                }
            });
        });

        if back_to_projects {
            *self.controller.command.lock().unwrap() = Some(AppCommand::OpenProjectManager);
            return;
        }

        Panel::left("media_pool")
            .resizable(true)
            .show_inside(ui, |ui| {
                ui.heading("MEDIA POOL");
                ui.separator();

                ui.horizontal(|ui| {
                    ui.text_edit_singleline(&mut editor.search_query);
                    if ui.button("Search").clicked()
                        && !editor
                            .is_searching
                            .load(std::sync::atomic::Ordering::Relaxed)
                    {
                        editor
                            .is_searching
                            .store(true, std::sync::atomic::Ordering::Relaxed);
                        let query = editor.search_query.clone();
                        let results_arc = Arc::clone(&editor.search_results);
                        let searching_arc = Arc::clone(&editor.is_searching);
                        let ctx_clone = ctx.clone();

                        std::thread::spawn(move || match crate::geocoding::search(&query) {
                            Ok(results) => {
                                {
                                    let mut locked = results_arc.lock().unwrap();
                                    *locked = results;
                                }
                                searching_arc.store(false, std::sync::atomic::Ordering::Relaxed);
                                ctx_clone.request_repaint();

                                let count = results_arc.lock().unwrap().len();
                                for i in 0..count {
                                    {
                                        let mut locked = results_arc.lock().unwrap();
                                        if let Some(loc) = locked.get_mut(i) {
                                            crate::geocoding::prepare_location(loc);
                                        }
                                    }
                                    ctx_clone.request_repaint();
                                }
                            }
                            Err(_) => {
                                searching_arc.store(false, std::sync::atomic::Ordering::Relaxed);
                                ctx_clone.request_repaint();
                            }
                        });
                    }
                });

                if editor
                    .is_searching
                    .load(std::sync::atomic::Ordering::Relaxed)
                {
                    ui.spinner();
                } else {
                    egui::ScrollArea::vertical()
                        .drag_to_scroll(false)
                        .show(ui, |ui| {
                            if let Ok(locked) = editor.search_results.lock() {
                                for (_i, res) in locked.iter().enumerate() {
                                    let is_dragging_this = editor
                                        .dragging_location
                                        .as_ref()
                                        .map(|d| d.display_name == res.display_name)
                                        .unwrap_or(false);

                                    let desired_size = egui::vec2(ui.available_width(), 36.0);
                                    let (row_rect, row_resp) = ui.allocate_exact_size(
                                        desired_size,
                                        egui::Sense::click_and_drag(),
                                    );

                                    let bg = if is_dragging_this {
                                        egui::Color32::from_rgb(0, 80, 160)
                                    } else if row_resp.hovered() {
                                        egui::Color32::from_gray(55)
                                    } else {
                                        egui::Color32::from_gray(40)
                                    };
                                    ui.painter().rect_filled(row_rect, 4.0, bg);

                                    ui.painter().text(
                                        row_rect.left_center() + egui::vec2(10.0, 0.0),
                                        egui::Align2::LEFT_CENTER,
                                        format!("• {}", &res.display_name),
                                        egui::FontId::proportional(12.0),
                                        egui::Color32::WHITE,
                                    );

                                    if row_resp.dragged() {
                                        editor.dragging_location = Some(res.clone());
                                        ui.ctx().set_cursor_icon(egui::CursorIcon::Grabbing);
                                    }

                                    if row_resp.hovered() {
                                        egui::show_tooltip_at_pointer(
                                            ui.ctx(),
                                            ui.layer_id(),
                                            egui::Id::new("loc_tip"),
                                            |ui| {
                                                ui.label("Drag onto the Timeline");
                                            },
                                        );
                                    }

                                    ui.add_space(2.0);
                                }
                            }
                        });
                }
            });

        Panel::right("inspector")
            .resizable(true)
            .default_size(250.0)
            .show_inside(ui, |ui| {
                ui.add_space(5.0);
                ui.horizontal(|ui| {
                    ui.selectable_value(&mut editor.inspector_tab, InspectorTab::Camera, "Camera");
                    ui.selectable_value(&mut editor.inspector_tab, InspectorTab::Inspector, "Inspector");
                });
                ui.separator();

                match editor.inspector_tab {
                    InspectorTab::Camera => {
                        ui.label(egui::RichText::new("Camera Settings").strong());
                        ui.add_space(5.0);

                        ui.separator();
                        ui.label("Map Viewport");

                        let current_zoom = editor.map.zoom();
                        let mut zoom_val = current_zoom;

                        ui.horizontal(|ui| {
                            ui.label("Zoom:");
                            let changed = ui.add(egui::Slider::new(&mut zoom_val, 0.1..=20.0)).changed();
                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                if let Some(ch) = editor.map.track.channels.get_mut("Zoom") {
                                    let (clicked, has_kf) = keyframe_button(
                                          ui,
                                          ch,
                                          editor.map.current_frame,
                                          animation::Value::Float(zoom_val),
                                      );

                                    if changed {
                                        ch.insert_keyframe(animation::Keyframe {
                                            frame: editor.map.current_frame,
                                            value: animation::Value::Float(zoom_val),
                                            interpolation: animation::Interpolation::Linear,
                                            flags: animation::KeyframeFlags::NONE,
                                        });
                                    }
                                }
                            });
                        });

                        let current_pos = editor.map.parameter_cache.get("Position")
                            .map(|c| c.value.clone())
                            .unwrap_or(animation::Value::Position(0.0, 20.0));

                        if let animation::Value::Position(mut lon, mut lat) = current_pos {
                            ui.horizontal(|ui| {
                                ui.label("Pos X:");
                                let changed = ui.add(egui::DragValue::new(&mut lon).speed(0.1)).changed();
                                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                    if let Some(ch) = editor.map.track.channels.get_mut("Position") {
                                        keyframe_button(
                                                ui,
                                                ch,
                                                editor.map.current_frame,
                                                animation::Value::Position(lon, lat),
                                            );

                                        if changed {
                                            ch.insert_keyframe(animation::Keyframe {
                                                frame: editor.map.current_frame,
                                                value: animation::Value::Position(lon, lat),
                                                interpolation: animation::Interpolation::Linear,
                                                flags: animation::KeyframeFlags::NONE,
                                            });
                                        }
                                    }
                                });

                            });

                            ui.horizontal(|ui| {
                                ui.label("Pos Y:");
                                let changed = ui.add(egui::DragValue::new(&mut lat).speed(0.1)).changed();
                                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                    if let Some(ch) = editor.map.track.channels.get_mut("Position") {
                                        keyframe_button(
                                                ui,
                                                ch,
                                                editor.map.current_frame,
                                                animation::Value::Position(lon, lat),
                                            );

                                        if changed {
                                            ch.insert_keyframe(animation::Keyframe {
                                                frame: editor.map.current_frame,
                                                value: animation::Value::Position(lon, lat),
                                                interpolation: animation::Interpolation::Linear,
                                                flags: animation::KeyframeFlags::NONE,
                                            });
                                        }
                                    }
                                });

                            });
                        }

                        ui.separator();
                        ui.label("Motion Hints");
                        ui.add(egui::Label::new(egui::RichText::new("Move the slider to automatically create or update keyframes at the current frame.").weak())
                            .wrap_mode(egui::TextWrapMode::Wrap));
                    }
                    InspectorTab::Inspector => {
                        ui.label(egui::RichText::new("Clip Properties").strong());
                        ui.add_space(5.0);

                        if let Some((track_idx, clip_idx)) = editor.selected_clip {
                            let mut snap_loc = None;
                            let mut delete_requested = false;

                            if let Some(obj_track) = editor.map.track.object_tracks.get_mut(track_idx) {
                                if let Some(clip) = obj_track.clips.get_mut(clip_idx) {
                                    ui.group(|ui| {
                                        ui.label(format!("Type: Location"));
                                        ui.horizontal(|ui| {
                                            ui.label("Name:");
                                            ui.text_edit_singleline(&mut clip.name);
                                        });
                                        ui.label(format!("Start: {}f", clip.start_frame));
                                        ui.label(format!("End: {}f", clip.end_frame));
                                    });

                                    ui.add_space(10.0);
                                    ui.label("Highlight Color");
                                    ui.horizontal(|ui| {
                                        let mut color = egui::Color32::from_rgba_unmultiplied(
                                            clip.color[0], clip.color[1], clip.color[2], clip.color[3]
                                        );
                                        if ui.color_edit_button_srgba(&mut color).changed() {
                                            clip.color = color.to_array();
                                        }

                                        let presets: &[([u8; 4], &str)] = &[
                                            ([255, 140, 0,  100], "Orange"),
                                            ([0,  120, 255, 100], "Blue"),
                                            ([255, 50,  50, 100], "Red"),
                                            ([50,  200, 50, 100], "Green"),
                                        ];
                                        ui.horizontal(|ui| {
                                            for &(rgba, label) in presets {
                                                let [r, g, b, _] = rgba;
                                                let swatch = egui::Button::new("")
                                                    .fill(egui::Color32::from_rgb(r, g, b))
                                                    .min_size(egui::vec2(20.0, 20.0));
                                                if ui.add(swatch).on_hover_text(label).clicked() {
                                                    clip.color = rgba;
                                                }
                                            }
                                        });
                                    });
                                    ui.add_space(10.0);
                                    ui.label(egui::RichText::new("Transition Preset").strong());

                                    ui.add_space(10.0);
                                    ui.label(egui::RichText::new("Transition In").strong());
                                    egui::ComboBox::from_id_salt("tx_in")
                                        .width(ui.available_width())
                                        .selected_text(format!("{:?}", clip.transition_in))
                                        .show_ui(ui, |ui| {
                                            for (label, preset) in [
                                                ("None",       animation::ClipPreset::None),
                                                ("Fade",       animation::ClipPreset::FadeIn),
                                                ("Pop",        animation::ClipPreset::PopIn),
                                                ("Bounce",     animation::ClipPreset::BounceIn),
                                                ("Grow-Fade",  animation::ClipPreset::GrowFade),
                                            ] {
                                                let selected = clip.transition_in == preset;

                                                if ui.selectable_label(selected, label).clicked() {
                                                    clip.transition_in = preset;
                                                    animation::apply_clip_preset(clip, preset, 20);
                                                }
                                            }
                                        });

                                    ui.add_space(8.0);
                                    ui.label(egui::RichText::new("Transition Out").strong());
                                    egui::ComboBox::from_id_salt("tx_out")
                                        .width(ui.available_width())
                                        .selected_text(match clip.transition_out {
                                            animation::ClipPreset::None => "None",
                                            animation::ClipPreset::FadeOut => "Fade",
                                            animation::ClipPreset::PopOut => "Pop",
                                            animation::ClipPreset::GrowFade => "Grow-Fade",
                                            _ => "Select...",
                                        })
                                        .show_ui(ui, |ui| {
                                            for (label, preset) in [
                                                ("None",       animation::ClipPreset::None),
                                                ("Fade",       animation::ClipPreset::FadeOut),
                                                ("Pop",        animation::ClipPreset::PopOut),
                                                ("Grow-Fade",  animation::ClipPreset::GrowFade),
                                            ] {
                                                let selected = clip.transition_out == preset;

                                                if ui.selectable_label(selected, label).clicked() {
                                                    clip.transition_out = preset;
                                                    animation::apply_clip_preset(clip, preset, 20);
                                                }
                                            }
                                        });

                                    ui.add_space(6.0);
                                    ui.label("Edit in Graph:");
                                    ui.horizontal(|ui| {
                                        for ch_name in ["Alpha", "Scale"] {
                                            let active = editor.selected_clip_channel.as_deref() == Some(ch_name);
                                            if ui.selectable_label(active, ch_name).clicked() {
                                                editor.selected_clip_channel = if active {
                                                    None
                                                } else {
                                                    editor.show_graph = true;
                                                    Some(ch_name.to_string())
                                                };
                                            }
                                        }
                                    });
                                    ui.add_space(10.0);
                                    if ui.button("Snap to Fit").clicked() {
                                        snap_loc = Some(clip.location.clone());
                                    }

                                    ui.add_space(5.0);
                                    if ui.button("Delete Clip").clicked() {
                                        delete_requested = true;
                                    }
                                }
                            }

                            if let Some(loc) = snap_loc {
                                editor.map.fit_to_location(&loc);
                            }
                            if delete_requested {
                                if let Some(track) = editor.map.track.object_tracks.get_mut(track_idx) {
                                    track.clips.remove(clip_idx);
                                    editor.selected_clip = None;
                                }
                            }
                        } else {
                            ui.vertical_centered(|ui| {
                                ui.add_space(20.0);
                                ui.label(egui::RichText::new("No clip selected").weak());
                                ui.label("Click a clip on the timeline to edit properties");
                            });
                        }
                    }
                }
            });

        Panel::bottom("timeline")
            .resizable(true)
            .default_size(200.0)
            .show_inside(ui, |ui| {
                ui.horizontal(|ui| {
                    if ui
                        .button(egui_phosphor::regular::SKIP_BACK)
                        .on_hover_text("Go to Start")
                        .clicked()
                    {
                        editor.map.current_frame = 0;
                        editor.map.is_playing = false;
                    }

                    if ui
                        .button(egui_phosphor::regular::CARET_LEFT)
                        .on_hover_text("Previous Frame")
                        .clicked()
                    {
                        if editor.map.current_frame > 0 {
                            editor.map.current_frame -= 1;
                        }
                        editor.map.is_playing = false;
                    }

                    let play_icon = if editor.map.is_playing {
                        egui_phosphor::regular::PAUSE
                    } else {
                        egui_phosphor::regular::PLAY
                    };
                    if ui.button(play_icon).on_hover_text("Play/Pause").clicked() {
                        editor.map.is_playing = !editor.map.is_playing;
                    }

                    if ui
                        .button(egui_phosphor::regular::CARET_RIGHT)
                        .on_hover_text("Next Frame")
                        .clicked()
                    {
                        if editor.map.current_frame < 1800 {
                            editor.map.current_frame += 1;
                        }
                        editor.map.is_playing = false;
                    }

                    if ui
                        .button(egui_phosphor::regular::SKIP_FORWARD)
                        .on_hover_text("Go to End")
                        .clicked()
                    {
                        editor.map.current_frame = 1800;
                        editor.map.is_playing = false;
                    }

                    ui.add_space(20.0);
                    ui.label(
                        egui::RichText::new(format!("Frame: {:04}", editor.map.current_frame))
                            .monospace(),
                    );
                });

                ui.separator();

                if editor.show_graph {
                    let drawn = if let (Some((ti, ci)), Some(ch_name)) =
                        (editor.selected_clip, &editor.selected_clip_channel)
                    {
                        if let Some(ch) = editor
                            .map
                            .track
                            .object_tracks
                            .get_mut(ti)
                            .and_then(|t| t.clips.get_mut(ci))
                            .and_then(|clip| clip.channels.get_mut(ch_name))
                        {
                            editor.graph_editor.ui(ui, ch);
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    };

                    if !drawn {
                        if let Some(ch) = editor.map.track.channels.get_mut("Zoom") {
                            editor.graph_editor.ui(ui, ch);
                        }
                    }
                } else {
                    let old_sel = editor.selected_clip;
                    let dropped = editor.timeline.ui(
                        ui,
                        &mut editor.map,
                        &editor.dragging_location,
                        &mut editor.selected_clip,
                    );
                    if editor.selected_clip != old_sel && editor.selected_clip.is_some() {
                        editor.inspector_tab = InspectorTab::Inspector;
                    }

                    let pointer_up = ui.input(|i| !i.pointer.any_down());
                    if dropped {
                        editor.dragging_location = None;
                    } else if editor.dragging_location.is_some() && pointer_up {
                        editor.dragging_location = None;
                    }
                }
            });

        egui::CentralPanel::default().show_inside(ui, |ui| {
            editor.render_view(ui, true);
        });
    }
}
