use eframe::egui::{CentralPanel, Panel};
use eframe::{self, egui};

mod engine;
mod animation;
mod transitions;
mod ui_graph;
mod timeline;

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

struct MyApp {
    map: MapEngine,
    graph_editor: GraphEditor,
    timeline: Timeline,
    show_graph: bool,
}

impl MyApp {
    fn new(cc: &eframe::CreationContext<'_>) -> Self {
        Self {
            map: MapEngine::new(cc),
            graph_editor: GraphEditor::new(),
            timeline: Timeline::new(),
            show_graph: false,
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

        Panel::left("media_pool")
            .resizable(true)
            .default_size(180.0)
            .show_inside(ui, |ui| {
                ui.heading("MEDIA");
            });

        Panel::right("inspector")
            .resizable(true)
            .default_size(220.0)
            .show_inside(ui, |ui| {
                ui.heading("INSPECTOR");
                ui.separator();
                
                ui.label(format!("Frame: {}", self.map.current_frame));
                
                ui.separator();
                ui.label("Map Settings");
                
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
            });

        Panel::bottom("timeline")
            .resizable(true)
            .default_size(200.0)
            .show_inside(ui, |ui| {
                ui.horizontal(|ui| {
                   ui.set_max_width(80.0);
                   if ui.button(if self.map.is_playing { "⏸" } else { "▶" }).clicked() {
                       self.map.is_playing = !self.map.is_playing;
                   }
                   
                   ui.label(format!("Frame: {}", self.map.current_frame));
                });

                ui.separator();

                if self.show_graph {
                    if let Some(ch) = self.map.track.channels.get_mut("Zoom") {
                        self.graph_editor.ui(ui, ch);
                    }
                } else {
                    self.timeline.ui(ui, &mut self.map);
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
