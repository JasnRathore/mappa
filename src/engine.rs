use eframe::egui;
use std::collections::HashMap;

pub struct MapEngine {
    pub zoom: u32,
    pub center_lat: f64,
    pub center_lon: f64,

    tile_cache: HashMap<(u32, u32, u32), egui::TextureHandle>,
    tile_size: usize,
}

impl MapEngine {
    pub fn new() -> Self {
        Self {
            zoom: 3,
            center_lat: 20.0,
            center_lon: 0.0,
            tile_cache: HashMap::new(),
            tile_size: 256,
        }
    }

    fn lat_lon_to_tile(&self, lat: f64, lon: f64) -> (u32, u32) {
        let lat_rad = lat.to_radians();
        let n = 2.0_f64.powi(self.zoom as i32);

        let x = ((lon + 180.0) / 360.0 * n).floor();
        let y = ((1.0 - (lat_rad.tan() + 1.0 / lat_rad.cos()).ln() / std::f64::consts::PI) / 2.0
            * n)
            .floor();

        (x as u32, y as u32)
    }

    fn fetch_tile(z: u32, x: u32, y: u32) -> Option<egui::ColorImage> {
        let url = format!("https://tile.openstreetmap.org/{}/{}/{}.png", z, x, y);

        let client = reqwest::blocking::Client::new();

        let resp = client
            .get(url)
            .header(
                reqwest::header::USER_AGENT,
                "mappar/0.1 (paradisegamer98@gmail.com)", // 👈 REQUIRED
            )
            .send()
            .ok()?;

        let bytes = resp.bytes().ok()?;

        let image = image::load_from_memory(&bytes).ok()?.to_rgba8();
        let size = [image.width() as usize, image.height() as usize];

        Some(egui::ColorImage::from_rgba_unmultiplied(size, &image))
    }

    fn get_tile_texture(
        &mut self,
        ctx: &egui::Context,
        z: u32,
        x: u32,
        y: u32,
    ) -> Option<&egui::TextureHandle> {
        if !self.tile_cache.contains_key(&(z, x, y)) {
            if let Some(img) = Self::fetch_tile(z, x, y) {
                let texture = ctx.load_texture(
                    format!("tile_{}_{}_{}", z, x, y),
                    img,
                    egui::TextureOptions::default(),
                );
                self.tile_cache.insert((z, x, y), texture);
            }
        }

        self.tile_cache.get(&(z, x, y))
    }

    pub fn ui(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        let (rect, response) = ui.allocate_exact_size(ui.available_size(), egui::Sense::drag());

        let painter = ui.painter_at(rect);

        let (center_x, center_y) = self.lat_lon_to_tile(self.center_lat, self.center_lon);

        let tile_size = self.tile_size as f32;
        let tiles_radius = 2;

        for dx in -(tiles_radius as i32)..=(tiles_radius as i32) {
            for dy in -(tiles_radius as i32)..=(tiles_radius as i32) {
                let tx = center_x as i32 + dx;
                let ty = center_y as i32 + dy;

                if tx < 0 || ty < 0 {
                    continue;
                }

                let tx = tx as u32;
                let ty = ty as u32;

                if let Some(texture) = self.get_tile_texture(ctx, self.zoom, tx, ty) {
                    let x = rect.center().x + dx as f32 * tile_size;
                    let y = rect.center().y + dy as f32 * tile_size;

                    let tile_rect = egui::Rect::from_min_size(
                        egui::pos2(x, y),
                        egui::vec2(tile_size, tile_size),
                    );

                    painter.image(
                        texture.id(),
                        tile_rect,
                        egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)),
                        egui::Color32::WHITE,
                    );
                }
            }
        }

        if response.dragged() {
            let delta = response.drag_delta();
            let scale = 1.0 / (256.0 * 2f64.powi(self.zoom as i32));

            self.center_lon -= delta.x as f64 * scale * 360.0;
            self.center_lat += delta.y as f64 * scale * 360.0;
            self.center_lat = self.center_lat.clamp(-85.0, 85.0);
        }

        if response.hovered() {
            let scroll = ui.input(|i| i.smooth_scroll_delta.y);

            if scroll > 0.0 {
                self.zoom = (self.zoom + 1).min(19);
            } else if scroll < 0.0 {
                self.zoom = self.zoom.saturating_sub(1);
            }
        }
    }
}
