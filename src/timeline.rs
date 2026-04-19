use eframe::egui::{self, Color32, Painter, Pos2, Rect, Stroke, Vec2};
use crate::animation::Channel;
use crate::engine::MapEngine;

pub struct Timeline {
    pub pan_x: f32,
    pub zoom_x: f32,
    pub track_height: f32,
    pub sidebar_width: f32,
    pub dragging_kf: Option<(String, usize)>, // (Channel Name, Keyframe Index)
}

impl Timeline {
    pub fn new() -> Self {
        Self {
            pan_x: 20.0,
            zoom_x: 2.0, // pixels per frame
            track_height: 30.0,
            sidebar_width: 100.0,
            dragging_kf: None,
        }
    }

    pub fn ui(&mut self, ui: &mut egui::Ui, engine: &mut MapEngine, dragging_location: &Option<crate::geocoding::LocationResult>, selected_clip: &mut Option<(usize, usize)>) -> bool {
        let mut dropped = false;
        let available_size = ui.available_size();
        let (rect, response) = ui.allocate_at_least(available_size, egui::Sense::click_and_drag());
        
        let painter = ui.painter_at(rect);
        
        // 1. Draw Sidebar Background
        let sidebar_rect = Rect::from_min_max(
            rect.min,
            Pos2::new(rect.min.x + self.sidebar_width, rect.max.y)
        );
        painter.rect_filled(sidebar_rect, 0.0, Color32::from_gray(35));
        
        // 2. Draw Main Timeline Background
        let timeline_rect = Rect::from_min_max(
            Pos2::new(sidebar_rect.max.x, rect.min.y),
            rect.max
        );
        painter.rect_filled(timeline_rect, 0.0, Color32::from_gray(25));

        // 3. Ruler Area
        let ruler_height = 25.0;
        let ruler_rect = Rect::from_min_max(
            Pos2::new(timeline_rect.min.x, timeline_rect.min.y),
            Pos2::new(timeline_rect.max.x, timeline_rect.min.y + ruler_height)
        );
        painter.rect_filled(ruler_rect, 0.0, Color32::from_gray(45));
        self.draw_ruler(&painter, ruler_rect);

        // 4. Tracks
        let tracks_rect = Rect::from_min_max(
            Pos2::new(timeline_rect.min.x, ruler_rect.max.y),
            timeline_rect.max
        );
        
        let mut track_v_offset = tracks_rect.min.y;
        
        // We'll iterate through fixed channels for now to keep it predictable
        let channel_names = vec!["Zoom", "Position", "Bearing", "Pitch"];
        
        for name in channel_names {
            let ch_rect = Rect::from_min_max(
                Pos2::new(rect.min.x, track_v_offset),
                Pos2::new(rect.max.x, track_v_offset + self.track_height)
            );
            
            // Draw Sidebar Label
            let label_pos = Pos2::new(rect.min.x + 10.0, track_v_offset + self.track_height / 2.0);
            painter.text(label_pos, egui::Align2::LEFT_CENTER, name, egui::FontId::proportional(12.0), Color32::GRAY);
            
            // Draw Track separator
            painter.line_segment(
                [Pos2::new(rect.min.x, ch_rect.max.y), Pos2::new(rect.max.x, ch_rect.max.y)],
                Stroke::new(1.0, Color32::from_gray(40))
            );

            // Draw Keyframes for this channel
            if let Some(ch) = engine.track.channels.get_mut(name) {
                self.draw_track_keyframes(&painter, ch_rect, ch, ui, engine.current_frame);
            }

            track_v_offset += self.track_height;
        }

        // 4b. Object Tracks (Locations, etc)

        let mut snap_loc = None;
        for (_track_idx, obj_track) in engine.track.object_tracks.iter_mut().enumerate() {
            let ch_rect = Rect::from_min_max(
                Pos2::new(rect.min.x, track_v_offset),
                Pos2::new(rect.max.x, track_v_offset + self.track_height)
            );
            
            // Draw Sidebar Label
            let label_pos = Pos2::new(rect.min.x + 10.0, track_v_offset + self.track_height / 2.0);
            painter.text(label_pos, egui::Align2::LEFT_CENTER, &obj_track.name, egui::FontId::proportional(12.0), Color32::GRAY);
            
            painter.line_segment(
                [Pos2::new(rect.min.x, ch_rect.max.y), Pos2::new(rect.max.x, ch_rect.max.y)],
                Stroke::new(1.0, Color32::from_gray(40))
            );

            // Draw Clips
            if let Some(loc) = self.draw_object_clips(&painter, ch_rect, obj_track, ui, engine.current_frame, _track_idx, selected_clip) {
                snap_loc = Some(loc);
            }

            track_v_offset += self.track_height;
        }

        if let Some(loc) = snap_loc {
            engine.fit_to_location(&loc);
        }

        // 4c. Handle Drops - using manual drag state instead of egui::DragAndDrop
        if let Some(loc) = dragging_location {
            // Highlight if pointer is anywhere inside the overall timeline rect
            if ui.rect_contains_pointer(rect) {
                painter.rect_filled(tracks_rect, 0.0, Color32::from_rgba_premultiplied(0, 100, 200, 25));
                painter.rect_stroke(tracks_rect, 0.0, Stroke::new(2.0, Color32::from_rgb(0, 150, 255)), eframe::egui::StrokeKind::Middle);
                ui.ctx().set_cursor_icon(egui::CursorIcon::Copy);
            }

            // Detect drop (pointer release) anywhere in the full rect — generous hit area
            let released = ui.input(|i| i.pointer.any_released());
            let ptr_pos = ui.input(|i| i.pointer.interact_pos().or(i.pointer.hover_pos()));

            if released {
                if let Some(ptr_pos) = ptr_pos {
                    if rect.contains(ptr_pos) {
                        let frame = ((ptr_pos.x - timeline_rect.left() - self.pan_x) / self.zoom_x)
                            .max(0.0) as u32;

                        let clip = crate::animation::Clip {
                            name: loc.display_name.clone(),
                            start_frame: frame,
                            end_frame: frame + 90,
                            location: loc.clone(),
                            color: [255, 140, 0, 100], // Default: Semi-transparent Orange
                        };

                        // Determine which object track to drop into (or create a new one)
                        let row_y = (ptr_pos.y - ruler_rect.max.y) / self.track_height;
                        let param_track_count = 4usize; // Zoom, Position, Bearing, Pitch
                        let clicked_idx = row_y.floor() as isize - param_track_count as isize;

                        if clicked_idx >= 0 && (clicked_idx as usize) < engine.track.object_tracks.len() {
                            engine.track.object_tracks[clicked_idx as usize].clips.push(clip);
                        } else {
                            let track_n = engine.track.object_tracks.len() + 1;
                            let mut new_track = crate::animation::ObjectTrack::new(
                                &format!("Location {}", track_n)
                            );
                            new_track.clips.push(clip);
                            engine.track.object_tracks.push(new_track);
                        }
                        dropped = true;
                    }
                }
            }
        }

        // 5. Playhead (Scrubber)
        self.draw_playhead(&painter, timeline_rect, ruler_rect, engine);

        // 6. Interaction
        self.handle_input(ui, response, timeline_rect, ruler_rect, engine);

        dropped
    }

    fn draw_ruler(&self, painter: &Painter, rect: Rect) {
        let frame_step = if self.zoom_x < 1.0 { 100 } else if self.zoom_x < 5.0 { 50 } else { 10 };
        let start_frame = ((-self.pan_x) / self.zoom_x).floor() as i32;
        let end_frame = ((rect.width() - self.pan_x) / self.zoom_x).ceil() as i32;

        for f in (start_frame..end_frame).step_by(frame_step as usize) {
            let x = rect.left() + self.pan_x + f as f32 * self.zoom_x;
            if x >= rect.left() && x <= rect.right() {
                painter.line_segment(
                    [Pos2::new(x, rect.bottom() - 5.0), Pos2::new(x, rect.bottom())],
                    Stroke::new(1.0, Color32::GRAY)
                );
                painter.text(
                    Pos2::new(x, rect.top() + 5.0),
                    egui::Align2::CENTER_TOP,
                    f.to_string(),
                    egui::FontId::proportional(10.0),
                    Color32::from_gray(150)
                );
            }
        }
    }

    fn draw_track_keyframes(&mut self, painter: &Painter, rect: Rect, channel: &mut Channel, ui: &mut egui::Ui, current_frame: u32) {
        for i in 0..channel.keyframes.len() {
            let kf = &channel.keyframes[i];
            let x = rect.left() + self.sidebar_width + self.pan_x + kf.frame as f32 * self.zoom_x;
            
            if x < rect.left() + self.sidebar_width || x > rect.right() { continue; }

            let pos = Pos2::new(x, rect.center().y);
            
            let is_on_current = kf.frame == current_frame;
            let color = if is_on_current {
                Color32::from_rgb(255, 128, 0) // Orange for "Active"
            } else {
                Color32::from_rgb(180, 180, 180)
            };

            // Diamond shape
            let size = 6.0;
            let diamond = vec![
                pos + Vec2::new(0.0, -size),
                pos + Vec2::new(size, 0.0),
                pos + Vec2::new(0.0, size),
                pos + Vec2::new(-size, 0.0),
            ];
            
            painter.add(egui::Shape::convex_polygon(diamond, color, Stroke::NONE));

            // Interaction for dragging
            let kf_id = ui.id().with(&channel.name).with(i);
            let kf_rect = Rect::from_center_size(pos, Vec2::splat(12.0));
            let kf_resp = ui.interact(kf_rect, kf_id, egui::Sense::drag());

            if kf_resp.dragged() {
                self.dragging_kf = Some((channel.name.clone(), i));
                let delta_x = kf_resp.drag_delta().x;
                let frame_delta = (delta_x / self.zoom_x).round() as i32;
                
                if frame_delta != 0 {
                    let kf_mut = &mut channel.keyframes[i];
                    kf_mut.frame = (kf_mut.frame as i32 + frame_delta).max(0) as u32;
                    channel.dirty = true;
                }
            }
        }

        if channel.dirty {
            channel.keyframes.sort_by_key(|k| k.frame);
        }
    }

    fn draw_object_clips(&mut self, painter: &Painter, rect: Rect, track: &mut crate::animation::ObjectTrack, ui: &mut egui::Ui, current_frame: u32, track_idx: usize, selected_clip: &mut Option<(usize, usize)>) -> Option<crate::geocoding::LocationResult> {
        let mut action_loc = None;
        for (i, clip) in track.clips.iter_mut().enumerate() {
            let start_x = rect.left() + self.sidebar_width + self.pan_x + clip.start_frame as f32 * self.zoom_x;
            let end_x = rect.left() + self.sidebar_width + self.pan_x + clip.end_frame as f32 * self.zoom_x;
            
            // Culling
            if end_x < rect.left() + self.sidebar_width || start_x > rect.right() { continue; }

            let clip_rect = Rect::from_min_max(
                Pos2::new(start_x.max(rect.left() + self.sidebar_width), rect.top() + 4.0),
                Pos2::new(end_x.min(rect.right()), rect.bottom() - 4.0)
            );

            let is_active = current_frame >= clip.start_frame && current_frame <= clip.end_frame;
            
            let fill_color = if is_active {
                Color32::from_rgb(0, 100, 200)
            } else {
                Color32::from_rgb(40, 60, 90)
            };

            painter.rect_filled(clip_rect, 2.0, fill_color);
            
            let is_selected = *selected_clip == Some((track_idx, i));
            let stroke_color = if is_selected {
                Color32::WHITE
            } else {
                Color32::from_rgb(0, 150, 255)
            };
            let stroke_width = if is_selected { 2.0 } else { 1.0 };
            
            painter.rect_stroke(clip_rect, 2.0, Stroke::new(stroke_width, stroke_color), eframe::egui::StrokeKind::Middle);

            // Color Strip at bottom
            let strip_height = 2.0;
            let strip_rect = Rect::from_min_max(
                Pos2::new(clip_rect.left(), clip_rect.bottom() - strip_height),
                clip_rect.max
            );
            let [r, g, b, _a] = clip.color;
            painter.rect_filled(strip_rect, 0.0, Color32::from_rgba_unmultiplied(r, g, b, 255)); // Full alpha for strip

            // Label
            painter.text(
                Pos2::new(clip_rect.left() + 5.0, clip_rect.center().y),
                egui::Align2::LEFT_CENTER,
                &clip.name,
                egui::FontId::proportional(10.0),
                Color32::WHITE
            );

            // Interaction (Click and Drag clip)
            let clip_id = ui.id().with(&track.name).with(i);
            let clip_resp = ui.interact(clip_rect, clip_id, egui::Sense::click_and_drag());

            if clip_resp.clicked() {
                *selected_clip = Some((track_idx, i));
            }

            if clip_resp.dragged() {
                let delta_x = clip_resp.drag_delta().x;
                let frame_delta = (delta_x / self.zoom_x).round() as i32;
                
                if frame_delta != 0 {
                    let new_start = (clip.start_frame as i32 + frame_delta).max(0) as u32;
                    let duration = clip.end_frame - clip.start_frame;
                    clip.start_frame = new_start;
                    clip.end_frame = new_start + duration;
                }
            }
        }
        action_loc
    }

    fn draw_playhead(&self, painter: &Painter, timeline_rect: Rect, ruler_rect: Rect, engine: &MapEngine) {
        let x = timeline_rect.left() + self.pan_x + engine.current_frame as f32 * self.zoom_x;
        if x < timeline_rect.left() || x > timeline_rect.right() { return; }

        let stroke = Stroke::new(2.0, Color32::from_rgb(0, 150, 255));
        
        // Vertical line
        painter.line_segment(
            [Pos2::new(x, ruler_rect.top()), Pos2::new(x, timeline_rect.bottom())],
            stroke
        );

        // Cap at top
        painter.circle_filled(Pos2::new(x, ruler_rect.top() + 5.0), 4.0, Color32::from_rgb(0, 150, 255));
    }

    fn handle_input(&mut self, ui: &mut egui::Ui, response: egui::Response, timeline_rect: Rect, ruler_rect: Rect, engine: &mut MapEngine) {
        // Scrubbing
        if ui.rect_contains_pointer(ruler_rect) && ui.input(|i| i.pointer.primary_down()) {
            if let Some(pos) = ui.input(|i| i.pointer.hover_pos()) {
                let frame = ((pos.x - timeline_rect.left() - self.pan_x) / self.zoom_x).max(0.0) as u32;
                engine.current_frame = frame.min(1800);
            }
        }

        // Panning (Middle Mouse or Drag background)
        if response.dragged_by(egui::PointerButton::Middle) {
            self.pan_x += response.drag_delta().x;
        }

        // Zooming (Ctrl + Scroll)
        let zoom_delta = ui.input(|i| i.smooth_scroll_delta.y);
        if ui.input(|i| i.modifiers.command) && zoom_delta != 0.0 {
            let last_zoom = self.zoom_x;
            self.zoom_x = (self.zoom_x * (1.1f32.powf(zoom_delta / 10.0))).clamp(0.1, 100.0);
            
            // Adjust pan to zoom around pointer
            if let Some(pos) = ui.input(|i| i.pointer.hover_pos()) {
                let relative_x = pos.x - timeline_rect.left() - self.pan_x;
                self.pan_x -= relative_x * (self.zoom_x / last_zoom - 1.0);
            }
        }
    }
}
