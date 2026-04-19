use walkers::{Plugin, Projector, MapMemory};
use eframe::egui::{self, Ui, Color32, Stroke, Pos2};
use crate::animation::Track;

pub struct MapHighlightPlugin<'a> {
    pub current_frame: u32,
    pub track: &'a Track,
    pub triangulation_cache: &'a mut std::collections::HashMap<String, Vec<usize>>,
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
                
                draw_location(painter, projector, self.triangulation_cache, &clip.location, fill_color, outline);
            }
        }
    }
}

fn draw_location(
    painter: &egui::Painter,
    projector: &Projector,
    cache: &mut std::collections::HashMap<String, Vec<usize>>,
    loc: &crate::geocoding::LocationResult,
    fill: Color32,
    outline: Stroke,
) {
    let Some(geojson) = &loc.geojson else { return };
    let Some(type_str) = geojson.get("type").and_then(|t| t.as_str()) else { return };

    match type_str {
        "Polygon" => {
            if let Some(coords) = geojson.get("coordinates").and_then(|c| c.as_array()) {
                draw_polygon(painter, projector, cache, &loc.display_name, coords, fill, outline);
            }
        }
        "MultiPolygon" => {
            if let Some(polys) = geojson.get("coordinates").and_then(|c| c.as_array()) {
                for (i, poly) in polys.iter().enumerate() {
                    if let Some(coords) = poly.as_array() {
                        let key = format!("{}_{}", loc.display_name, i);
                        draw_polygon(painter, projector, cache, &key, coords, fill, outline);
                    }
                }
            }
        }
        _ => {}
    }
}

fn draw_polygon(
    painter: &egui::Painter,
    projector: &Projector,
    cache: &mut std::collections::HashMap<String, Vec<usize>>,
    cache_key: &str,
    rings: &Vec<serde_json::Value>,
    fill: Color32,
    outline: Stroke,
) {
    if rings.is_empty() { return; }

    let mut projected_rings: Vec<Vec<Pos2>> = Vec::new();
    for ring in rings {
        let Some(pts) = ring.as_array() else { continue };
        if pts.len() < 3 { continue; }

        let projected: Vec<Pos2> = pts.iter().filter_map(|pt| {
            let c = pt.as_array()?;
            if c.len() < 2 { return None; }
            let lon = c[0].as_f64()?;
            let lat = c[1].as_f64()?;
            let px = projector.project(walkers::Position::new(lon, lat));
            Some(Pos2::new(px.x as f32, px.y as f32))
        }).collect();

        if projected.len() >= 3 {
            projected_rings.push(projected);
        }
    }

    if projected_rings.is_empty() { return; }

    // 1. Triangulation for Fill
    let mut mesh = egui::Mesh::default();
    let mut flat_vertices = Vec::new();
    let mut hole_indices = Vec::new();
    let mut current_index = 0;

    for (i, ring) in projected_rings.iter().enumerate() {
        if i > 0 {
            hole_indices.push(current_index);
        }
        for &p in ring {
            flat_vertices.push(p.x as f64);
            flat_vertices.push(p.y as f64);
            mesh.vertices.push(egui::epaint::Vertex {
                pos: p,
                uv: Pos2::ZERO,
                color: fill.into(),
            });
            current_index += 1;
        }
    }

    if let Some(indices) = cache.get(cache_key) {
        mesh.indices = indices.iter().map(|&i| i as u32).collect();
        painter.add(egui::Shape::mesh(mesh));
    } else if let Ok(indices) = earcutr::earcut(&flat_vertices, &hole_indices, 2) {
        mesh.indices = indices.iter().map(|&i| i as u32).collect();
        cache.insert(cache_key.to_string(), indices);
        painter.add(egui::Shape::mesh(mesh));
    }

    // 2. Outlines (Draw AFTER fill to keep sharp)
    for (i, ring) in projected_rings.iter().enumerate() {
        painter.add(egui::Shape::Path(egui::epaint::PathShape {
            points: ring.clone(),
            closed: true,
            fill: Color32::TRANSPARENT,
            stroke: outline.into(),
        }));
    }
}
