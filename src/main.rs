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

fn main() -> Result<(), eframe::Error> {
    let args: Vec<String> = std::env::args().collect();
    let controller = AppController {
        command: Arc::new(Mutex::new(None)),
    };

    if args.contains(&"--editor".to_string()) {
        run_editor(controller.clone());
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
            )))
        }),
    );
}

fn run_editor(controller: AppController) {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1200.0, 800.0])
            .with_title("Editor"),
        ..Default::default()
    };

    let _ = eframe::run_native(
        "Editor",
        options,
        Box::new(|cc| {
            Ok(Box::new(MyApp::new(
                cc,
                controller.clone(),
                AppState::Editor,
            )))
        }),
    );
}

#[derive(PartialEq, Clone, Copy)]
enum InspectorTab {
    Camera,
    Inspector,
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
}

#[derive(Clone)]
struct AppController {
    command: Arc<Mutex<Option<AppCommand>>>,
}

#[derive(Clone)]
enum AppCommand {
    OpenEditor,
    OpenProjectManager,
    CloseSelf,
}
struct MyApp {
    controller: AppController,
    app_state: AppState,

    project_manager: project_manager::ProjectManager,
    editor: EditorState,

    new_project_name: String,
    show_new_project_dialog: bool,
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

        let editor_state = EditorState {
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
        };

        Self {
            controller,
            app_state: initial_state,
            project_manager: project_manager::ProjectManager::new(),
            editor: editor_state,
            new_project_name: String::new(),
            show_new_project_dialog: false,
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
                AppCommand::OpenEditor => {
                    std::process::Command::new(std::env::current_exe().unwrap())
                        .arg("--editor")
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
    }
}

impl MyApp {
    fn ui_project_manager(&mut self, ui: &mut egui::Ui) {
        egui::CentralPanel::default().show_inside(ui, |ui| {
            if let Some(action) = self.project_manager.ui(ui) {
                match action {
                    project_manager::ProjectAction::Open(project_idx) => {
                        if let Ok(_path) = self.project_manager.open_project(project_idx) {
                            *self.controller.command.lock().unwrap() = Some(AppCommand::OpenEditor);
                        }
                    }
                    project_manager::ProjectAction::NewProject => {
                        self.show_new_project_dialog = true;
                    }
                }
            }
        });

        if self.show_new_project_dialog {
            let mut open = true;
            egui::Window::new("New Project")
                .open(&mut open)
                .resizable(false)
                .show(ui.ctx(), |ui| {
                    ui.horizontal(|ui| {
                        ui.label("Project Name:");
                        ui.text_edit_singleline(&mut self.new_project_name);
                    });

                    ui.horizontal(|ui| {
                        if ui.button("Create").clicked() && !self.new_project_name.is_empty() {
                            if let Ok(_) =
                                self.project_manager.create_project(&self.new_project_name)
                            {
                                self.new_project_name.clear();
                                self.show_new_project_dialog = false;
                                self.app_state = AppState::Editor;
                            }
                        }
                        if ui.button("Cancel").clicked() {
                            self.new_project_name.clear();
                            self.show_new_project_dialog = false;
                        }
                    });
                });
            self.show_new_project_dialog = open;
        }
    }

    fn ui_editor(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let editor = &mut self.editor;

        let ctx = ui.ctx().clone();

        editor.map.update();

        let dissolve = editor
            .map
            .parameter_cache
            .get("Dissolve")
            .map(|c| c.value.as_float())
            .unwrap_or(0.0);

        let wipe = editor
            .map
            .parameter_cache
            .get("Wipe")
            .map(|c| c.value.as_float())
            .unwrap_or(1.0);

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
                });
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
            let rect = ui.max_rect();
            let wipe_width = rect.width() * wipe as f32;
            let wipe_rect = egui::Rect::from_min_max(
                rect.min,
                rect.min + egui::vec2(wipe_width, rect.height()),
            );

            ui.set_clip_rect(wipe_rect);
            editor.map.ui(ui);

            if dissolve > 0.0 {
                ui.painter().rect_filled(
                    rect,
                    0.0,
                    egui::Color32::BLACK.linear_multiply(dissolve as f32),
                );
            }
        });
    }
}
