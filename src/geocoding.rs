use geo::Coord;
use geo::CoordsIter;
use geo::LineString;
use geo::Orient;
use geo::Polygon;
use geo::Simplify;
use geo::TriangulateDelaunay;
use geo::TriangulateEarcut;
use geo::triangulate_delaunay::DelaunayTriangulationConfig;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use walkers::Position;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparedPolygon {
    pub vertices: Vec<Position>, // World coordinates (lon, lat)
    pub triangulation: Vec<u32>,
    pub rings: Vec<Vec<Position>>, // For outlines (as separate paths)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocationResult {
    pub display_name: String,
    pub lat: String,
    pub lon: String,
    pub boundingbox: Vec<String>,
    pub geojson: Option<Value>, // The original polygon geometry
    pub prepared_geometry: Option<Vec<PreparedPolygon>>,
}

// Change the search function:
pub fn search(query: &str) -> Result<Vec<LocationResult>, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("mappar_app/0.1.0")
        .build()
        .map_err(|e| e.to_string())?;

    // polygon_threshold=0.005 pre-simplifies server-side — India goes from ~3MB to ~50KB
    // limit=5 is plenty for a media pool picker
    let url = format!(
        "https://nominatim.openstreetmap.org/search?q={}&format=jsonv2&polygon_geojson=1&polygon_threshold=0.005&limit=5",
        urlencoding::encode(query)
    );

    let res = client.get(&url).send().map_err(|e| e.to_string())?;
    let results: Vec<LocationResult> = res.json().map_err(|e| e.to_string())?;

    // *** No geometry prep here — done in background after spinner clears ***
    Ok(results)
}

// New public function called from the background thread in main.rs
pub fn prepare_location(location: &mut LocationResult) {
    if location.prepared_geometry.is_some() {
        return; // already done
    }
    if let Some(geojson) = location.geojson.clone() {
        location.prepared_geometry = Some(prepare_geometry(&geojson));
    }
}

fn prepare_geometry(geojson: &Value) -> Vec<PreparedPolygon> {
    let mut prepared = Vec::new();

    let Some(type_str) = geojson.get("type").and_then(|t| t.as_str()) else {
        return prepared;
    };

    match type_str {
        "Polygon" => {
            if let Some(coords) = geojson.get("coordinates").and_then(|c| c.as_array()) {
                if let Some(p) =
                    polygon_from_geojson_rings(coords).and_then(geo_polygon_to_prepared)
                {
                    prepared.push(p);
                }
            }
        }
        "MultiPolygon" => {
            if let Some(polys) = geojson.get("coordinates").and_then(|c| c.as_array()) {
                for poly_coords in polys {
                    if let Some(coords) = poly_coords.as_array() {
                        if let Some(p) =
                            polygon_from_geojson_rings(coords).and_then(geo_polygon_to_prepared)
                        {
                            prepared.push(p);
                        }
                    }
                }
            }
        }
        _ => {}
    }

    prepared
}

fn coord_from_geojson_point(pt: &Value) -> Option<Coord<f64>> {
    let c = pt.as_array()?;
    if c.len() < 2 {
        return None;
    }
    let lon = c[0].as_f64()?;
    let lat = c[1].as_f64()?;
    if !lon.is_finite() || !lat.is_finite() {
        return None;
    }
    if !(-180.0..=180.0).contains(&lon) || !(-90.0..=90.0).contains(&lat) {
        return None;
    }
    Some(Coord { x: lon, y: lat })
}

fn polygon_from_geojson_rings(rings: &Vec<Value>) -> Option<Polygon<f64>> {
    if rings.is_empty() {
        return None;
    }

    let mut exterior = Vec::new();
    let mut interiors = Vec::new();

    for (i, ring) in rings.iter().enumerate() {
        let pts = ring.as_array()?;
        let points: Vec<Coord<f64>> = pts.iter().filter_map(coord_from_geojson_point).collect();

        if points.len() < 3 {
            continue;
        }

        if i == 0 {
            exterior = points;
        } else {
            interiors.push(LineString::new(points));
        }
    }

    if exterior.len() < 3 {
        return None;
    }

    Some(Polygon::new(LineString::new(exterior), interiors))
}

fn triangles_to_mesh(triangles: &[geo_types::Triangle<f64>]) -> (Vec<Position>, Vec<u32>) {
    let mut vertices = Vec::with_capacity(triangles.len() * 3);
    let mut triangulation = Vec::with_capacity(triangles.len() * 3);
    for tri in triangles {
        let base = vertices.len() as u32;
        for c in [tri.v1(), tri.v2(), tri.v3()] {
            vertices.push(Position::new(c.x, c.y));
        }
        triangulation.extend_from_slice(&[base, base + 1, base + 2]);
    }
    (vertices, triangulation)
}

fn triangulate_polygon_mesh(poly: &Polygon<f64>) -> Option<(Vec<Position>, Vec<u32>)> {
    let cfg = DelaunayTriangulationConfig::default();
    if let Ok(tris) = poly.constrained_triangulation(cfg) {
        if !tris.is_empty() {
            return Some(triangles_to_mesh(&tris));
        }
    }
    let loose = DelaunayTriangulationConfig {
        snap_radius: 0.001,
        ..Default::default()
    };
    if let Ok(tris) = poly.constrained_triangulation(loose) {
        if !tris.is_empty() {
            return Some(triangles_to_mesh(&tris));
        }
    }
    let raw_tri = poly.earcut_triangles_raw();
    if raw_tri.triangle_indices.is_empty() {
        return None;
    }
    let triangulation = raw_tri
        .triangle_indices
        .into_iter()
        .map(|i| i as u32)
        .collect();
    let mut vertices = Vec::with_capacity(raw_tri.vertices.len() / 2);
    for chunk in raw_tri.vertices.chunks_exact(2) {
        vertices.push(Position::new(chunk[0], chunk[1]));
    }
    Some((vertices, triangulation))
}

fn geo_polygon_to_prepared(poly: Polygon<f64>) -> Option<PreparedPolygon> {
    if poly.exterior().coords_count() < 3 {
        return None;
    }

    let poly = poly.orient(geo::orient::Direction::Default);
    let simplified = poly.simplify(&0.0001);

    let (vertices, triangulation) = triangulate_polygon_mesh(&simplified)?;

    let mut rings_positions = Vec::new();
    rings_positions.push(
        simplified
            .exterior()
            .coords()
            .map(|c| Position::new(c.x, c.y))
            .collect(),
    );
    for interior in simplified.interiors() {
        rings_positions.push(interior.coords().map(|c| Position::new(c.x, c.y)).collect());
    }

    Some(PreparedPolygon {
        vertices,
        triangulation,
        rings: rings_positions,
    })
}
