use geo::{Polygon, LineString, TriangulateEarcut, CoordsIter};

fn main() {
    let poly = Polygon::new(LineString::from(vec![
        (0., 0.),
        (1., 0.),
        (0.5, 0.0), // degenerate point forming a line
        (1., 1.),
        (0., 1.),
        (0., 0.),
    ]), vec![]);

    let raw = poly.earcut_triangles_raw();
    println!("Poly coords_count: {}", poly.exterior().coords_count());
    println!("Raw vertices len/2: {}", raw.vertices.len() / 2);
    println!("Indices: {:?}", raw.triangle_indices);
}
