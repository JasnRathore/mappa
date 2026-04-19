use walkers::{Plugin, Projector, MapMemory};
use eframe::egui::{self, Ui, Color32, Stroke, Pos2};
use crate::animation::Track;

pub struct MapHighlightPlugin<'a> {
    pub current_frame: u32,
    pub track: &'a Track,
}

impl<'a> Plugin for MapHighlightPlugin<'a> {
    fn run(self: Box<Self>, ui: &mut Ui, _response: &eframe::egui::Response, projector: &Projector, map_memory: &MapMemory) {
        let painter = ui.painter();
        let zoom = map_memory.zoom() as f32;

        // Scale stroke width with zoom: thinner when zoomed out, thicker when zoomed in
        let outline_width = (1.0 + zoom * 0.2).clamp(1.5, 5.0);
        let outline = Stroke::new(outline_width, Color32::from_rgb(255, 140, 0));

        for obj_track in &self.track.object_tracks {
            for clip in &obj_track.clips {
                if self.current_frame < clip.start_frame || self.current_frame > clip.end_frame {
                    continue;
                }
                draw_location(painter, projector, &clip.location, outline);
            }
        }
    }
}

fn draw_location(
    painter: &egui::Painter,
    projector: &Projector,
    loc: &crate::geocoding::LocationResult,
    outline: Stroke,
) {
    let Some(geojson) = &loc.geojson else { return };
    let Some(type_str) = geojson.get("type").and_then(|t| t.as_str()) else { return };

    match type_str {
        "Polygon" => {
            if let Some(coords) = geojson.get("coordinates").and_then(|c| c.as_array()) {
                if let Some(ring) = coords.first() {
                    draw_ring_outline(painter, projector, ring, outline);
                }
            }
        }
        "MultiPolygon" => {
            if let Some(polys) = geojson.get("coordinates").and_then(|c| c.as_array()) {
                for poly in polys {
                    if let Some(rings) = poly.as_array() {
                        if let Some(ring) = rings.first() {
                            draw_ring_outline(painter, projector, ring, outline);
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

fn draw_ring_outline(
    painter: &egui::Painter,
    projector: &Projector,
    ring: &serde_json::Value,
    outline: Stroke,
) {
    let Some(pts) = ring.as_array() else { return };
    if pts.len() < 3 { return; }

    // Project ALL points first, then simplify by screen-space distance.
    // This avoids the squiggly artifact caused by step_by skipping important detail points.
    let all_screen: Vec<Pos2> = pts.iter().filter_map(|pt| {
        let c = pt.as_array()?;
        if c.len() < 2 { return None; }
        let lon = c[0].as_f64()?;
        let lat = c[1].as_f64()?;
        let px = projector.project(walkers::Position::new(lon, lat));
        Some(Pos2::new(px.x as f32, px.y as f32))
    }).collect();

    if all_screen.len() < 2 { return; }

    // Douglas-Peucker-like simplification: skip points that are within
    // min_dist pixels of the previous kept point. This preserves detail
    // at high zoom while reducing draw calls at low zoom.
    let min_dist_sq: f32 = 4.0; // 2px minimum distance between kept points
    let mut simplified: Vec<Pos2> = Vec::with_capacity(all_screen.len() / 2);
    simplified.push(all_screen[0]);

    for i in 1..all_screen.len() {
        let last = *simplified.last().unwrap();
        let cur = all_screen[i];
        let dx = cur.x - last.x;
        let dy = cur.y - last.y;
        if dx * dx + dy * dy >= min_dist_sq {
            simplified.push(cur);
        }
    }

    // Always include the last point to close the ring properly
    if simplified.len() >= 2 && *simplified.last().unwrap() != *all_screen.last().unwrap() {
        simplified.push(*all_screen.last().unwrap());
    }

    if simplified.len() < 2 { return; }

    // Draw each segment
    for i in 0..simplified.len() {
        let a = simplified[i];
        let b = simplified[(i + 1) % simplified.len()];
        painter.line_segment([a, b], outline);
    }
}
