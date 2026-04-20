use crate::animation::{Channel, Interpolation, Keyframe, KeyframeFlags, Value};
use eframe::egui::{self, Color32, Painter, Pos2, Rect, Stroke, Vec2};

pub struct GraphEditor {
    pub selected_kf: Option<usize>,
    pub pan: Vec2,
    pub zoom: Vec2,
}

impl GraphEditor {
    pub fn new() -> Self {
        Self {
            selected_kf: None,
            pan: Vec2::new(0.0, 0.0),
            zoom: Vec2::new(10.0, 50.0), // pixels per frame, pixels per unit
        }
    }

    pub fn ui(&mut self, ui: &mut egui::Ui, channel: &mut Channel) {
        let (rect, response) =
            ui.allocate_at_least(ui.available_size(), egui::Sense::click_and_drag());

        let painter = ui.painter_at(rect);

        // Draw background grid
        self.draw_grid(&painter, rect);

        // Draw curves
        self.draw_curves(&painter, rect, channel);

        // Interaction
        if response.dragged() {
            self.pan += response.drag_delta();
        }

        // Draw keyframes
        for i in 0..channel.keyframes.len() {
            let kf = &channel.keyframes[i];
            let pos = self.frame_to_pos(kf.frame, kf.value.as_float(), rect);

            let color = if Some(i) == self.selected_kf {
                Color32::WHITE
            } else {
                Color32::from_rgb(200, 100, 0)
            };

            let kf_rect = Rect::from_center_size(pos, Vec2::splat(10.0));
            let kf_resp = ui.interact(kf_rect, ui.id().with(i), egui::Sense::drag());

            if kf_resp.clicked() {
                self.selected_kf = Some(i);
                // Flag as selected in data
                channel.keyframes[i].flags.insert(KeyframeFlags::SELECTED);
            }

            if kf_resp.dragged() {
                self.selected_kf = Some(i);
                let delta = kf_resp.drag_delta();

                // Map delta to frame/value changes
                let df = (delta.x / self.zoom.x).round() as i32;
                let dv = -(delta.y / self.zoom.y) as f64;

                if df != 0 || dv != 0.0 {
                    let kf_mut = &mut channel.keyframes[i];
                    kf_mut.frame = (kf_mut.frame as i32 + df).max(0) as u32;

                    match &mut kf_mut.value {
                        Value::Float(f) => *f += dv,
                        Value::Position(lon, _) => *lon += dv, // Simple mapping for now
                        Value::Vec2(x, _) => *x += dv,
                    }

                    channel.dirty = true;
                }
            }

            painter.circle_filled(pos, 4.0, color);
        }

        // Sort if frames changed and re-flag dirty
        if channel.dirty {
            channel.keyframes.sort_by_key(|k| k.frame);
        }
    }

    fn frame_to_pos(&self, frame: u32, value: f64, rect: Rect) -> Pos2 {
        let x = rect.left() + self.pan.x + frame as f32 * self.zoom.x;
        let y = rect.center().y - self.pan.y - value as f32 * self.zoom.y;
        Pos2::new(x, y)
    }

    fn draw_grid(&self, painter: &Painter, rect: Rect) {
        painter.rect_filled(rect, 0.0, Color32::from_gray(30));

        let stroke = Stroke::new(1.0, Color32::from_gray(50));

        // Vertical lines (frames)
        let frame_step = 10;
        let start_frame = ((-self.pan.x) / self.zoom.x).floor() as i32;
        let end_frame = ((rect.width() - self.pan.x) / self.zoom.x).ceil() as i32;

        for f in (start_frame..end_frame).step_by(frame_step as usize) {
            let x = rect.left() + self.pan.x + f as f32 * self.zoom.x;
            if x >= rect.left() && x <= rect.right() {
                painter.line_segment(
                    [Pos2::new(x, rect.top()), Pos2::new(x, rect.bottom())],
                    stroke,
                );
            }
        }
    }

    fn draw_curves(&self, painter: &Painter, rect: Rect, channel: &Channel) {
        if channel.keyframes.len() < 2 {
            return;
        }

        for window in channel.keyframes.windows(2) {
            let k1 = &window[0];
            let k2 = &window[1];

            let p1 = self.frame_to_pos(k1.frame, k1.value.as_float(), rect);
            let p2 = self.frame_to_pos(k2.frame, k2.value.as_float(), rect);

            match k1.interpolation {
                Interpolation::Linear => {
                    painter.line_segment([p1, p2], Stroke::new(2.0, Color32::GOLD));
                }
                Interpolation::Step => {
                    let p_mid = Pos2::new(p2.x, p1.y);
                    painter.line_segment([p1, p_mid], Stroke::new(2.0, Color32::GOLD));
                    painter.line_segment([p_mid, p2], Stroke::new(2.0, Color32::GOLD));
                }
                Interpolation::Bezier {
                    handle_out,
                    handle_in,
                    ..
                } => {
                    // Draw Bezier approximation
                    let mut points = Vec::new();
                    let steps = 20;
                    for i in 0..=steps {
                        let t = i as f64 / steps as f64;

                        // Replicate the cubic_bezier_sample logic
                        let it = 1.0 - t;
                        let v_start = 0.0;
                        let v_end = 1.0;
                        let cp1 = handle_out.1;
                        let cp2 = 1.0 + handle_in.1;

                        let t_adj = it * it * it * v_start
                            + 3.0 * it * it * t * cp1
                            + 3.0 * it * t * t * cp2
                            + t * t * t * v_end;

                        let frame = k1.frame as f32 + t as f32 * (k2.frame - k1.frame) as f32;
                        let val = k1.value.as_float()
                            + t_adj * (k2.value.as_float() - k1.value.as_float());
                        points.push(self.frame_to_pos(frame as u32, val, rect));
                    }

                    for window in points.windows(2) {
                        painter.line_segment(
                            [window[0], window[1]],
                            Stroke::new(2.0, Color32::YELLOW),
                        );
                    }
                }
                _ => {
                    // Fallback to ease visualization or linear
                    painter.line_segment([p1, p2], Stroke::new(2.0, Color32::GOLD));
                }
            }
        }
    }
}
