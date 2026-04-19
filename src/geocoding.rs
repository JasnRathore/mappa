use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocationResult {
    pub display_name: String,
    pub lat: String,
    pub lon: String,
    pub boundingbox: Vec<String>,
    pub geojson: Option<Value>, // The polygon geometry
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

    let results: Vec<LocationResult> = res.json().map_err(|e| e.to_string())?;
    
    Ok(results)
}
