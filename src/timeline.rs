use eframe::egui::{self, Color32, Painter, Pos2, Rect, Stroke, Vec2};
use crate::animation::{Channel, KeyframeFlags, Track, Value};
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

    pub fn ui(&mut self, ui: &mut egui::Ui, engine: &mut MapEngine) {
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

        // 5. Playhead (Scrubber)
        self.draw_playhead(&painter, timeline_rect, ruler_rect, engine);

        // 6. Interaction
        self.handle_input(ui, response, timeline_rect, ruler_rect, engine);
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
