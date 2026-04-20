use eframe::egui::{self, Color32, Pos2, Rect, Stroke, Ui};
use walkers::{MapMemory, Plugin, Position, Projector};

use crate::animation::Track;
use crate::geocoding::PreparedPolygon;

const MAX_PROJECTED_COORD: f32 = 100_000.0;
const MAX_OUTLINE_EDGE_PX: f32 = 600.0;
const MAX_FILL_EDGE_PX: f32 = 2_048.0;
const MIN_RING_POINT_DISTANCE: f32 = 0.5;

pub struct MapHighlightPlugin<'a> {
    pub current_frame: u32,
    pub track: &'a Track,
    pub scale: f32,
}

impl<'a> Plugin for MapHighlightPlugin<'a> {
    fn run(
        self: Box<Self>,
        ui: &mut Ui,
        _response: &eframe::egui::Response,
        projector: &Projector,
        map_memory: &MapMemory,
    ) {
        let painter = ui.painter();
        let zoom = map_memory.zoom() as f32;
        let outline_width = (1.2 + (zoom - self.scale.log2()) * 0.18).clamp(1.5, 5.0) * self.scale;
        let scanline_step = fill_scanline_step(zoom);

        for obj_track in &self.track.object_tracks {
            for clip in &obj_track.clips {
                if self.current_frame < clip.start_frame || self.current_frame > clip.end_frame {
                    continue;
                }

                let [r, g, b, a] = clip.color;
                let alpha = clip.get_param("Alpha", self.current_frame) as f32;
                let scale = clip.get_param("Scale", self.current_frame) as f32;

                let fill_alpha = (a as f32 * alpha).clamp(0.0, 255.0) as u8;
                let stroke_alpha = (255.0_f32 * alpha).clamp(0.0, 255.0) as u8;
                let fill_color = Color32::from_rgba_unmultiplied(r, g, b, fill_alpha);
                let stroke_color = Color32::from_rgba_unmultiplied(r, g, b, stroke_alpha);
                let outline = Stroke::new(outline_width, stroke_color);

                if let Some(prepared) = &clip.location.prepared_geometry {
                    for poly in prepared {
                        draw_prepared_polygon(
                            painter,
                            projector,
                            poly,
                            fill_color,
                            outline,
                            scanline_step,
                            scale,
                        );
                    }
                }
            }
        }
    }
}

#[derive(Default)]
struct ProjectedPolygon {
    fill_rings: Vec<Vec<Pos2>>,
    outline_segments: Vec<Vec<Pos2>>,
    bounds: Option<Rect>,
}

fn draw_prepared_polygon(
    painter: &egui::Painter,
    projector: &Projector,
    poly: &PreparedPolygon,
    fill: Color32,
    outline: Stroke,
    scanline_step: f32,
    scale: f32,
) {
    let projected = project_polygon(projector, poly);

    if let Some(bounds) = projected.bounds {
        if bounds.width() < 2.0 && bounds.height() < 2.0 {
            return;
        }
    }

    // Apply scale around the centroid of the bounding box
    let projected = if (scale - 1.0).abs() > 0.001 {
        scale_projected(projected, scale)
    } else {
        projected
    };

    if !projected.fill_rings.is_empty() {
        draw_scanline_fill(
            painter,
            &projected.fill_rings,
            projected.bounds,
            fill,
            scanline_step,
        );
    }

    for segment in projected.outline_segments {
        if segment.len() < 2 {
            continue;
        }
        let closed = is_closed_segment(&segment);
        painter.add(egui::Shape::Path(egui::epaint::PathShape {
            points: segment,
            closed,
            fill: Color32::TRANSPARENT,
            stroke: outline.into(),
        }));
    }
}

fn scale_projected(mut proj: ProjectedPolygon, scale: f32) -> ProjectedPolygon {
    let center = match proj.bounds {
        Some(b) => b.center(),
        None => return proj,
    };

    let scale_ring = |ring: Vec<Pos2>| -> Vec<Pos2> {
        ring.into_iter()
            .map(|p| center + (p - center) * scale)
            .collect()
    };

    proj.fill_rings = proj.fill_rings.into_iter().map(scale_ring).collect();
    proj.outline_segments = proj.outline_segments.into_iter().map(scale_ring).collect();
    // Recompute bounds
    proj.bounds = None;
    for ring in &proj.fill_rings {
        extend_bounds(&mut proj.bounds, ring);
    }
    proj
}

fn project_polygon(projector: &Projector, poly: &PreparedPolygon) -> ProjectedPolygon {
    let mut projected = ProjectedPolygon::default();

    for ring in &poly.rings {
        let projected_points: Vec<Option<Pos2>> = ring
            .iter()
            .map(|pos| project_screen(projector, *pos))
            .collect();
        projected
            .outline_segments
            .extend(split_outline_segments(&projected_points));

        if let Some(fill_ring) = projected_fill_ring(&projected_points) {
            extend_bounds(&mut projected.bounds, &fill_ring);
            projected.fill_rings.push(fill_ring);
        }
    }

    projected
}

fn project_screen(projector: &Projector, pos: Position) -> Option<Pos2> {
    let px = projector.project(pos);
    let p = Pos2::new(px.x as f32, px.y as f32);

    if p.x.is_finite()
        && p.y.is_finite()
        && p.x.abs() < MAX_PROJECTED_COORD
        && p.y.abs() < MAX_PROJECTED_COORD
    {
        Some(p)
    } else {
        None
    }
}

fn split_outline_segments(projected_points: &[Option<Pos2>]) -> Vec<Vec<Pos2>> {
    if projected_points.is_empty() {
        return Vec::new();
    }

    let len = projected_points.len();
    let mut segments = Vec::new();
    let mut current = Vec::new();

    for i in 0..=len {
        let curr = projected_points[i % len];
        let prev = if i == 0 {
            projected_points[len - 1]
        } else {
            projected_points[(i - 1) % len]
        };

        let keep_connected = match (prev, curr) {
            (Some(a), Some(b)) => (b - a).length() <= MAX_OUTLINE_EDGE_PX,
            _ => false,
        };

        match curr {
            Some(point) if keep_connected || current.is_empty() => {
                push_if_distinct(&mut current, point);
            }
            Some(point) => {
                finish_open_segment(&mut segments, &mut current);
                current.push(point);
            }
            None => finish_open_segment(&mut segments, &mut current),
        }
    }

    finish_open_segment(&mut segments, &mut current);
    segments
}

fn projected_fill_ring(projected_points: &[Option<Pos2>]) -> Option<Vec<Pos2>> {
    let mut ring = Vec::with_capacity(projected_points.len());
    for point in projected_points {
        ring.push((*point)?);
    }

    if ring.len() < 3 {
        return None;
    }

    dedupe_ring_points(&mut ring);
    if ring.len() < 3 {
        return None;
    }

    if ring_edges_too_large(&ring, MAX_FILL_EDGE_PX) {
        return None;
    }

    let area = signed_area(&ring);
    if !area.is_finite() || area.abs() < 1.0 {
        return None;
    }

    Some(ring)
}

fn draw_scanline_fill(
    painter: &egui::Painter,
    fill_rings: &[Vec<Pos2>],
    bounds: Option<Rect>,
    fill: Color32,
    scanline_step: f32,
) {
    let Some(bounds) = bounds else { return };
    if !bounds.is_positive() {
        return;
    }

    let mut step = scanline_step.max(1.0);
    let height = bounds.height();
    if height / step > 1_200.0 {
        step = (height / 1_200.0).ceil().max(1.0);
    }

    let mut y = bounds.top();
    while y <= bounds.bottom() {
        let mut intersections = Vec::new();

        for ring in fill_rings {
            append_scanline_intersections(ring, y, &mut intersections);
        }

        intersections.sort_by(|a, b| a.total_cmp(b));

        for pair in intersections.chunks_exact(2) {
            let x0 = pair[0];
            let x1 = pair[1];
            if !x0.is_finite() || !x1.is_finite() || x1 <= x0 {
                continue;
            }

            painter.line_segment(
                [Pos2::new(x0, y), Pos2::new(x1, y)],
                Stroke::new(step + 0.5, fill),
            );
        }

        y += step;
    }
}

fn append_scanline_intersections(ring: &[Pos2], scan_y: f32, intersections: &mut Vec<f32>) {
    if ring.len() < 3 {
        return;
    }

    for i in 0..ring.len() {
        let a = ring[i];
        let b = ring[(i + 1) % ring.len()];

        if !edge_crosses_scanline(a, b, scan_y) {
            continue;
        }

        let dy = b.y - a.y;
        if dy.abs() <= f32::EPSILON {
            continue;
        }

        let t = (scan_y - a.y) / dy;
        intersections.push(a.x + (b.x - a.x) * t);
    }
}

fn edge_crosses_scanline(a: Pos2, b: Pos2, scan_y: f32) -> bool {
    (a.y <= scan_y && b.y > scan_y) || (b.y <= scan_y && a.y > scan_y)
}

fn dedupe_ring_points(ring: &mut Vec<Pos2>) {
    ring.dedup_by(|a, b| {
        (*a - *b).length_sq() <= MIN_RING_POINT_DISTANCE * MIN_RING_POINT_DISTANCE
    });

    if ring.len() >= 2 {
        let first = ring[0];
        let last = ring[ring.len() - 1];
        if (last - first).length_sq() <= MIN_RING_POINT_DISTANCE * MIN_RING_POINT_DISTANCE {
            ring.pop();
        }
    }
}

fn ring_edges_too_large(ring: &[Pos2], max_edge: f32) -> bool {
    for i in 0..ring.len() {
        let a = ring[i];
        let b = ring[(i + 1) % ring.len()];
        if (b - a).length() > max_edge {
            return true;
        }
    }
    false
}

fn signed_area(ring: &[Pos2]) -> f32 {
    let mut sum = 0.0;
    for i in 0..ring.len() {
        let a = ring[i];
        let b = ring[(i + 1) % ring.len()];
        sum += a.x * b.y - b.x * a.y;
    }
    sum * 0.5
}

fn extend_bounds(bounds: &mut Option<Rect>, ring: &[Pos2]) {
    let mut min = ring[0];
    let mut max = ring[0];

    for point in ring.iter().copied().skip(1) {
        min.x = min.x.min(point.x);
        min.y = min.y.min(point.y);
        max.x = max.x.max(point.x);
        max.y = max.y.max(point.y);
    }

    let ring_rect = Rect::from_min_max(min, max);
    *bounds = Some(match bounds.take() {
        Some(existing) => existing.union(ring_rect),
        None => ring_rect,
    });
}

fn push_if_distinct(points: &mut Vec<Pos2>, point: Pos2) {
    let should_push = points
        .last()
        .map(|last| (*last - point).length_sq() > MIN_RING_POINT_DISTANCE * MIN_RING_POINT_DISTANCE)
        .unwrap_or(true);

    if should_push {
        points.push(point);
    }
}

fn finish_open_segment(segments: &mut Vec<Vec<Pos2>>, current: &mut Vec<Pos2>) {
    if current.len() >= 2 {
        segments.push(std::mem::take(current));
    } else {
        current.clear();
    }
}

fn is_closed_segment(points: &[Pos2]) -> bool {
    if points.len() < 3 {
        return false;
    }

    let first = points[0];
    let last = points[points.len() - 1];
    (last - first).length_sq() <= MIN_RING_POINT_DISTANCE * MIN_RING_POINT_DISTANCE
}

fn fill_scanline_step(zoom: f32) -> f32 {
    (2.4 - zoom * 0.08).clamp(1.0, 2.5)
}
