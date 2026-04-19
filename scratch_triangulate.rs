use geo::{Polygon, LineString, TriangulateEarcut, CoordsIter};

fn main() {
    // A simple square: 5 points (0 to 4), where p[4] == p[0]
    let exterior = LineString::new(vec![
        (0.0, 0.0).into(),
        (1.0, 0.0).into(),
        (1.0, 1.0).into(),
        (0.0, 1.0).into(),
        (0.0, 0.0).into(),
    ]);
    
    let poly = Polygon::new(exterior, vec![]);
    
    println!("LineString coords_count: {}", poly.exterior().coords_count());
    
    let raw = poly.earcut_triangles_raw();
    println!("RawTriangulation vertices len / 2: {}", raw.vertices.len() / 2);
    
    for (i, p) in raw.vertices.chunks_exact(2).enumerate() {
        println!("Vertex {}: {}, {}", i, p[0], p[1]);
    }
}
