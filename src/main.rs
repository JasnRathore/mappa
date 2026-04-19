use eframe::egui::{CentralPanel, Panel};
use eframe::{self, egui};

mod engine;
mod animation;
mod transitions;
mod ui_graph;
mod timeline;
mod geocoding;
mod map_plugin;

use engine::MapEngine;
use ui_graph::GraphEditor;
use timeline::Timeline;

fn main() -> Result<(), eframe::Error> {
    let options = eframe::NativeOptions::default();

    eframe::run_native(
        "Mappar",
        options,
        Box::new(|cc| Ok(Box::new(MyApp::new(cc)))),
    )
}

use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(PartialEq, Clone, Copy)]
enum InspectorTab {
    Camera,
    Inspector,
}

struct MyApp {
    map: MapEngine,
    graph_editor: GraphEditor,
    timeline: Timeline,
    show_graph: bool,
    search_query: String,
    search_results: Arc<Mutex<Vec<crate::geocoding::LocationResult>>>,
    is_searching: Arc<AtomicBool>,
    dragging_location: Option<crate::geocoding::LocationResult>,
    selected_clip: Option<(usize, usize)>,
    inspector_tab: InspectorTab,
}

impl MyApp {
    fn new(cc: &eframe::CreationContext<'_>) -> Self {
        Self {
            map: MapEngine::new(cc),
            graph_editor: GraphEditor::new(),
            timeline: Timeline::new(),
            show_graph: false,
            search_query: String::new(),
            search_results: Arc::new(Mutex::new(Vec::new())),
            is_searching: Arc::new(AtomicBool::new(false)),
            dragging_location: None,
            selected_clip: None,
            inspector_tab: InspectorTab::Camera,
        }
    }
}

impl eframe::App for MyApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx();
        
        // --- 1. EVALUATION PHASE ---
        // Ensure the engine ticks and resolves all animations BEFORE any UI reads state.
        self.map.update();



        let dissolve = self.map.parameter_cache.get("Dissolve")
            .map(|c| c.value.as_float())
            .unwrap_or(0.0);

        let wipe = self.map.parameter_cache.get("Wipe")
            .map(|c| c.value.as_float())
            .unwrap_or(1.0);

        let bearing = self.map.parameter_cache.get("Bearing")
            .map(|c| c.value.as_float())
            .unwrap_or(0.0);

        // Redraw loop for playback
        if self.map.is_playing {
            ctx.request_repaint();
        }
        
        egui::TopBottomPanel::top("menu_bar").show_inside(ui, |ui| {
            ui.horizontal(|ui| {
                ui.menu_button("File", |ui| {
                    if ui.button("New").clicked() { ui.close(); }
                    if ui.button("Open").clicked() { ui.close(); }
                    ui.separator();
                    if ui.button("Save").clicked() { ui.close(); }
                });
                ui.menu_button("View", |ui| {
                    ui.checkbox(&mut self.show_graph, "Graph Editor");
                });
            });
        });

        egui::SidePanel::left("media_pool")
            .resizable(true)
            .show_inside(ui, |ui| {
                ui.heading("MEDIA POOL");
                ui.separator();
                
                ui.horizontal(|ui| {
                    ui.text_edit_singleline(&mut self.search_query);
                    if ui.button("Search").clicked() && !self.is_searching.load(std::sync::atomic::Ordering::Relaxed) {
                        self.is_searching.store(true, std::sync::atomic::Ordering::Relaxed);
                        let query = self.search_query.clone();
                        let results_arc = Arc::clone(&self.search_results);
                        let searching_arc = Arc::clone(&self.is_searching);
                        
                        std::thread::spawn(move || {
                            if let Ok(res) = crate::geocoding::search(&query) {
                                if let Ok(mut locked) = results_arc.lock() {
                                    *locked = res;
                                }
                            }
                            searching_arc.store(false, std::sync::atomic::Ordering::Relaxed);
                        });
                    }
                });
                
                if self.is_searching.load(std::sync::atomic::Ordering::Relaxed) {
                    ui.spinner();
                } else {
                    // drag_to_scroll(false) is critical — otherwise the ScrollArea
                    // consumes all pointer drag events before the labels ever see them.
                    egui::ScrollArea::vertical().drag_to_scroll(false).show(ui, |ui| {
                        if let Ok(locked) = self.search_results.lock() {
                            for (_i, res) in locked.iter().enumerate() {
                                let is_dragging_this = self.dragging_location.as_ref()
                                    .map(|d| d.display_name == res.display_name)
                                    .unwrap_or(false);

                                let desired_size = egui::vec2(ui.available_width(), 36.0);
                                let (row_rect, row_resp) = ui.allocate_exact_size(desired_size, egui::Sense::click_and_drag());

                                // Background: highlight if being dragged
                                let bg = if is_dragging_this {
                                    egui::Color32::from_rgb(0, 80, 160)
                                } else if row_resp.hovered() {
                                    egui::Color32::from_gray(55)
                                } else {
                                    egui::Color32::from_gray(40)
                                };
                                ui.painter().rect_filled(row_rect, 4.0, bg);

                                // Icon + label text
                                ui.painter().text(
                                    row_rect.left_center() + egui::vec2(10.0, 0.0),
                                    egui::Align2::LEFT_CENTER,
                                    format!("📍 {}", &res.display_name),
                                    egui::FontId::proportional(12.0),
                                    egui::Color32::WHITE,
                                );

                                if row_resp.dragged() {
                                    self.dragging_location = Some(res.clone());
                                    ui.ctx().set_cursor_icon(egui::CursorIcon::Grabbing);
                                }

                                if row_resp.drag_stopped() {
                                    // Don't clear here — let the timeline consume and clear it
                                }

                                if row_resp.hovered() {
                                    egui::show_tooltip_at_pointer(ui.ctx(), ui.layer_id(), egui::Id::new("loc_tip"), |ui| {
                                        ui.label("Drag onto the Timeline");
                                    });
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
                    ui.selectable_value(&mut self.inspector_tab, InspectorTab::Camera, "🎥 Camera");
                    ui.selectable_value(&mut self.inspector_tab, InspectorTab::Inspector, "📋 Inspector");
                });
                ui.separator();
                
                match self.inspector_tab {
                    InspectorTab::Camera => {
                        ui.label(egui::RichText::new("Camera Settings").strong());
                        ui.add_space(5.0);
                
                        ui.label(format!("Frame: {}", self.map.current_frame));
                        
                        ui.separator();
                        ui.label("Map Viewport");
                
                let current_zoom = self.map.zoom();
                let mut zoom_val = current_zoom;
                
                ui.horizontal(|ui| {
                    ui.label("Zoom:");
                    let changed = ui.add(egui::Slider::new(&mut zoom_val, 0.1..=20.0)).changed() || 
                                  ui.add(egui::DragValue::new(&mut zoom_val).speed(0.1)).changed();
                    
                    if let Some(ch) = self.map.track.channels.get_mut("Zoom") {
                        let has_kf = ch.keyframes.iter().any(|k| k.frame == self.map.current_frame);
                        let kf_btn_color = if has_kf { egui::Color32::from_rgb(255, 128, 0) } else { egui::Color32::GRAY };
                        
                        if ui.button(egui::RichText::new("◆").color(kf_btn_color)).clicked() {
                            if has_kf {
                                ch.keyframes.retain(|k| k.frame != self.map.current_frame);
                            } else {
                                ch.insert_keyframe(animation::Keyframe {
                                    frame: self.map.current_frame,
                                    value: animation::Value::Float(zoom_val),
                                    interpolation: animation::Interpolation::Linear,
                                    flags: animation::KeyframeFlags::NONE,
                                });
                            }
                            ch.dirty = true;
                        }

                        if changed {
                            ch.insert_keyframe(animation::Keyframe {
                                frame: self.map.current_frame,
                                value: animation::Value::Float(zoom_val),
                                interpolation: animation::Interpolation::Linear,
                                flags: animation::KeyframeFlags::NONE,
                            });
                        }
                    }
                });

                let current_pos = self.map.parameter_cache.get("Position")
                    .map(|c| c.value.clone())
                    .unwrap_or(animation::Value::Position(0.0, 20.0));
                
                if let animation::Value::Position(mut lon, mut lat) = current_pos {
                    // Pos X Row
                    ui.horizontal(|ui| {
                        ui.label("Pos X:");
                        let changed = ui.add(egui::DragValue::new(&mut lon).speed(0.1)).changed();
                        
                        if let Some(ch) = self.map.track.channels.get_mut("Position") {
                            let has_kf = ch.keyframes.iter().any(|k| k.frame == self.map.current_frame);
                            let kf_btn_color = if has_kf { egui::Color32::from_rgb(255, 128, 0) } else { egui::Color32::GRAY };
                            
                            if ui.button(egui::RichText::new("◆").color(kf_btn_color)).clicked() {
                                if has_kf {
                                    ch.keyframes.retain(|k| k.frame != self.map.current_frame);
                                } else {
                                    ch.insert_keyframe(animation::Keyframe {
                                        frame: self.map.current_frame,
                                        value: animation::Value::Position(lon, lat),
                                        interpolation: animation::Interpolation::Linear,
                                        flags: animation::KeyframeFlags::NONE,
                                    });
                                }
                                ch.dirty = true;
                            }

                            if changed {
                                ch.insert_keyframe(animation::Keyframe {
                                    frame: self.map.current_frame,
                                    value: animation::Value::Position(lon, lat),
                                    interpolation: animation::Interpolation::Linear,
                                    flags: animation::KeyframeFlags::NONE,
                                });
                            }
                        }
                    });

                    // Pos Y Row
                    ui.horizontal(|ui| {
                        ui.label("Pos Y:");
                        let changed = ui.add(egui::DragValue::new(&mut lat).speed(0.1)).changed();
                        
                        if let Some(ch) = self.map.track.channels.get_mut("Position") {
                            let has_kf = ch.keyframes.iter().any(|k| k.frame == self.map.current_frame);
                            let kf_btn_color = if has_kf { egui::Color32::from_rgb(255, 128, 0) } else { egui::Color32::GRAY };
                            
                            if ui.button(egui::RichText::new("◆").color(kf_btn_color)).clicked() {
                                if has_kf {
                                    ch.keyframes.retain(|k| k.frame != self.map.current_frame);
                                } else {
                                    ch.insert_keyframe(animation::Keyframe {
                                        frame: self.map.current_frame,
                                        value: animation::Value::Position(lon, lat),
                                        interpolation: animation::Interpolation::Linear,
                                        flags: animation::KeyframeFlags::NONE,
                                    });
                                }
                                ch.dirty = true;
                            }

                            if changed {
                                ch.insert_keyframe(animation::Keyframe {
                                    frame: self.map.current_frame,
                                    value: animation::Value::Position(lon, lat),
                                    interpolation: animation::Interpolation::Linear,
                                    flags: animation::KeyframeFlags::NONE,
                                });
                            }
                        }
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

                        if let Some((track_idx, clip_idx)) = self.selected_clip {
                            let mut snap_loc = None;
                            let mut delete_requested = false;

                            if let Some(obj_track) = self.map.track.object_tracks.get_mut(track_idx) {
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
                                    if ui.button("🚀 Snap to Fit").clicked() {
                                        snap_loc = Some(clip.location.clone());
                                    }
                                    
                                    ui.add_space(5.0);
                                    if ui.button("🗑 Delete Clip").clicked() {
                                        delete_requested = true;
                                    }
                                }
                            }

                            // Perform actions that need &mut self.map after the borrow ends
                            if let Some(loc) = snap_loc {
                                self.map.fit_to_location(&loc);
                            }
                            if delete_requested {
                                if let Some(track) = self.map.track.object_tracks.get_mut(track_idx) {
                                    track.clips.remove(clip_idx);
                                    self.selected_clip = None;
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
                   // Playback Transport Controls
                   if ui.button("⏮").on_hover_text("Go to Start").clicked() {
                       self.map.current_frame = 0;
                       self.map.is_playing = false;
                   }
                   
                   if ui.button("◄").on_hover_text("Previous Frame").clicked() {
                       if self.map.current_frame > 0 {
                           self.map.current_frame -= 1;
                       }
                       self.map.is_playing = false;
                   }
                   
                   let play_icon = if self.map.is_playing { "⏸" } else { "▶" };
                   if ui.button(play_icon).on_hover_text("Play/Pause").clicked() {
                       self.map.is_playing = !self.map.is_playing;
                   }
                   
                   if ui.button("►").on_hover_text("Next Frame").clicked() {
                       if self.map.current_frame < 1800 {
                           self.map.current_frame += 1;
                       }
                       self.map.is_playing = false;
                   }
                   
                   if ui.button("⏭").on_hover_text("Go to End").clicked() {
                       self.map.current_frame = 1800; // Based on timeline max
                       self.map.is_playing = false;
                   }

                   ui.add_space(20.0);
                   ui.label(egui::RichText::new(format!("Frame: {:04}", self.map.current_frame)).monospace());
                });

                ui.separator();

                if self.show_graph {
                    if let Some(ch) = self.map.track.channels.get_mut("Zoom") {
                        self.graph_editor.ui(ui, ch);
                    }
                } else {
                    let old_sel = self.selected_clip;
                    let dropped = self.timeline.ui(ui, &mut self.map, &self.dragging_location, &mut self.selected_clip);
                    if self.selected_clip != old_sel && self.selected_clip.is_some() {
                        self.inspector_tab = InspectorTab::Inspector;
                    }
                    
                    let pointer_up = ui.input(|i| !i.pointer.any_down());
                    if dropped {
                        // Successful drop into timeline
                        self.dragging_location = None;
                    } else if self.dragging_location.is_some() && pointer_up {
                        // Mouse released outside timeline — cancel the drag
                        self.dragging_location = None;
                    }
                }
            });

        CentralPanel::default().show_inside(ui, |ui| {
            // Apply Wipe Effect
            let rect = ui.max_rect();
            let wipe_width = rect.width() * wipe as f32;
            let wipe_rect = egui::Rect::from_min_max(rect.min, rect.min + egui::vec2(wipe_width, rect.height()));
            
            ui.set_clip_rect(wipe_rect);
            self.map.ui(ui);
            
            // Compass / Bearing Visualization
            let compass_pos = rect.right_top() + egui::vec2(-60.0, 60.0);
            let painter = ui.painter();
            painter.circle_filled(compass_pos, 40.0, egui::Color32::from_gray(30));
            
            let angle = bearing.to_radians() as f32;
            let needle_end = compass_pos + egui::vec2(angle.sin() * 30.0, -angle.cos() * 30.0);
            painter.line_segment([compass_pos, needle_end], egui::Stroke::new(3.0, egui::Color32::RED));

            // Dissolve Overlay
            if dissolve > 0.0 {
                ui.painter().rect_filled(rect, 0.0, egui::Color32::BLACK.linear_multiply(dissolve as f32));
            }
        });
    }
}
