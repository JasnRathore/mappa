use eframe::egui;
use reqwest::header::HeaderValue;
use walkers::{HttpOptions, HttpTiles, Map, MapMemory, Position, sources::OpenStreetMap};

pub struct MapEngine {
    // HttpTiles is the concrete struct needed here
    pub tiles: HttpTiles,
    pub map_memory: MapMemory,
}

impl MapEngine {
    pub fn new(cc: &eframe::CreationContext<'_>) -> Self {
        let user_agent = HeaderValue::from_static("mappar/0.1 (paradisegamer98@gmail.com)");

        let options = HttpOptions {
            user_agent: Some(user_agent),
            ..Default::default()
        };

        Self {
            tiles: HttpTiles::with_options(OpenStreetMap, options, cc.egui_ctx.clone()),
            map_memory: MapMemory::default(),
        }
    }

    pub fn ui(&mut self, ui: &mut egui::Ui) {
        // Position uses (Lon, Lat)
        let start_pos = Position::new(0.0, 20.0);

        let map = Map::new(Some(&mut self.tiles), &mut self.map_memory, start_pos);

        ui.add(map);
    }

    pub fn zoom(&self) -> f64 {
        self.map_memory.zoom()
    }
}
