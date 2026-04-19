use walkers::{Plugin, Projector, MapMemory};
use eframe::egui::{self, Ui, Color32, Stroke, Pos2};
use crate::animation::Track;
use crate::geocoding::PreparedPolygon;

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

        for obj_track in &self.track.object_tracks {
            for clip in &obj_track.clips {
                if self.current_frame < clip.start_frame || self.current_frame > clip.end_frame {
                    continue;
                }
                
                let [r, g, b, a] = clip.color;
                let fill_color = Color32::from_rgba_unmultiplied(r, g, b, a);
                let stroke_color = Color32::from_rgba_unmultiplied(r, g, b, 255); // Opaque stroke
                let outline = Stroke::new(outline_width, stroke_color);
                
                if let Some(prepared) = &clip.location.prepared_geometry {
                    for poly in prepared {
                        draw_prepared_polygon(painter, projector, poly, fill_color, outline);
                    }
                }
            }
        }
    }
}

fn draw_prepared_polygon(
    painter: &egui::Painter,
    projector: &Projector,
    poly: &PreparedPolygon,
    fill: Color32,
    outline: Stroke,
) {
    // 1. Build Mesh from pre-calculated triangulation
    let mut mesh = egui::Mesh::default();
    for pos in &poly.vertices {
        let px = projector.project(*pos);
        let p = Pos2::new(px.x as f32, px.y as f32);
        
        // Finiteness check to prevent "rubberbanding" to (0,0) or infinity
        let p_safe = if p.x.is_finite() && p.y.is_finite() && p.x.abs() < 100_000.0 && p.y.abs() < 100_000.0 {
            p
        } else {
            Pos2::new(-1000.0, -1000.0) // Position far off-screen
        };

        mesh.vertices.push(egui::epaint::Vertex {
            pos: p_safe,
            uv: Pos2::ZERO,
            color: fill.into(),
        });
    }
    mesh.indices = poly.triangulation.clone();
    painter.add(egui::Shape::mesh(mesh));

    // 2. Outlines (Draw each ring as a separate path to avoid crossing lines)
    for ring in &poly.rings {
        let points: Vec<Pos2> = ring.iter().filter_map(|pos| {
            let px = projector.project(*pos);
            let p = Pos2::new(px.x as f32, px.y as f32);
            if p.x.is_finite() && p.y.is_finite() && p.x.abs() < 100_000.0 && p.y.abs() < 100_000.0 {
                Some(p)
            } else {
                None
            }
        }).collect();

        if points.len() >= 2 {
            painter.add(egui::Shape::Path(egui::epaint::PathShape {
                points,
                closed: true,
                fill: Color32::TRANSPARENT,
                stroke: outline.into(),
            }));
        }
    }
}
