use serde::{Deserialize, Serialize};
use serde_json::Value;
use geo::Simplify;
use geo::Orient;
use geo::TriangulateEarcut;
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

pub fn search(query: &str) -> Result<Vec<LocationResult>, String> {
    // Nominatim requires a user-agent
    let client = reqwest::blocking::Client::builder()
        .user_agent("mappar_app/0.1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!(
        "https://nominatim.openstreetmap.org/search?q={}&format=jsonv2&polygon_geojson=1",
        urlencoding::encode(query)
    );

    let res = client.get(&url).send().map_err(|e| e.to_string())?;

    let mut results: Vec<LocationResult> = res.json().map_err(|e| e.to_string())?;
    
    // Pre-process geometry for each result
    for result in &mut results {
        if let Some(geojson) = &result.geojson {
            result.prepared_geometry = Some(prepare_geometry(geojson));
        }
    }
    
    Ok(results)
}

fn prepare_geometry(geojson: &Value) -> Vec<PreparedPolygon> {
    let mut prepared = Vec::new();

    let Some(type_str) = geojson.get("type").and_then(|t| t.as_str()) else { return prepared };

    match type_str {
        "Polygon" => {
            if let Some(coords) = geojson.get("coordinates").and_then(|c| c.as_array()) {
                if let Some(p) = process_polygon_coords(coords) {
                    prepared.push(p);
                }
            }
        }
        "MultiPolygon" => {
            if let Some(polys) = geojson.get("coordinates").and_then(|c| c.as_array()) {
                for poly in polys {
                    if let Some(coords) = poly.as_array() {
                        if let Some(p) = process_polygon_coords(coords) {
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

fn process_polygon_coords(rings: &Vec<Value>) -> Option<PreparedPolygon> {
    if rings.is_empty() { return None; }

    use geo::Polygon;
    use geo::LineString;
    use geo::Coord;

    let mut exterior = Vec::new();
    let mut interiors = Vec::new();

    for (i, ring) in rings.iter().enumerate() {
        let Some(pts) = ring.as_array() else { continue };
        let points: Vec<Coord<f64>> = pts.iter().filter_map(|pt| {
            let c = pt.as_array()?;
            if c.len() < 2 { return None; }
            let lon = c[0].as_f64()?;
            let lat = c[1].as_f64()?;
            Some(Coord { x: lon, y: lat })
        }).collect();

        if points.len() < 3 { continue; }

        if i == 0 {
            exterior = points;
        } else {
            interiors.push(LineString::new(points));
        }
    }

    if exterior.len() < 3 { return None; }

    let poly = Polygon::new(LineString::new(exterior), interiors);
    
    // 1. Orient to ensure correct winding order
    let poly = poly.orient(geo::orient::Direction::Default);
    
    // 2. Simplify
    let simplified = poly.simplify(&0.0001);

    // 3. Triangulate
    let raw_tri = simplified.earcut_triangles_raw();
    let triangulation = raw_tri.triangle_indices.into_iter().map(|i| i as u32).collect();

    // 4. Build PreparedPolygon
    // raw_tri.vertices is a flat [x, y, x, y, ...] vector
    let mut vertices = Vec::with_capacity(raw_tri.vertices.len() / 2);
    for chunk in raw_tri.vertices.chunks_exact(2) {
        vertices.push(Position::new(chunk[0], chunk[1]));
    }

    let mut rings_positions = Vec::new();
    rings_positions.push(simplified.exterior().coords().map(|c| Position::new(c.x, c.y)).collect());
    for interior in simplified.interiors() {
        rings_positions.push(interior.coords().map(|c| Position::new(c.x, c.y)).collect());
    }

    Some(PreparedPolygon {
        vertices,
        triangulation,
        rings: rings_positions,
    })
}
