use eframe::egui;
use reqwest::header::HeaderValue;
use std::collections::HashMap;
use walkers::{HttpOptions, HttpTiles, Map, MapMemory, Position, sources::OpenStreetMap};

use crate::animation::{Channel, Interpolation, Keyframe, KeyframeFlags, Track, Value};

pub struct ParameterCache {
    pub value: Value,
    pub dirty: bool,
}

pub struct MapEngine {
    pub tiles: HttpTiles,
    pub map_memory: MapMemory,
    pub track: Track,
    pub current_frame: u32,
    pub is_playing: bool,
    pub last_update: Option<std::time::Instant>,
    pub accumulator: f64,
    pub last_evaluated_frame: Option<u32>,
    pub parameter_cache: HashMap<String, ParameterCache>,
    pub fps: f32,
}

impl MapEngine {
    pub fn new(cc: &eframe::CreationContext<'_>) -> Self {
        let user_agent = HeaderValue::from_static("mappar/0.1 (concise.offical@gmail.com)");

        let options = HttpOptions {
            user_agent: Some(user_agent),
            ..Default::default()
        };

        let mut track = Track::new("Map");

        // Initialize default channels
        let mut zoom_ch = Channel::new("Zoom");
        zoom_ch.insert_keyframe(Keyframe {
            frame: 0,
            value: Value::Float(2.0),
            interpolation: Interpolation::Linear,
            flags: KeyframeFlags::NONE,
        });
        track.channels.insert("Zoom".to_string(), zoom_ch);

        let mut pos_ch = Channel::new("Position");
        pos_ch.insert_keyframe(Keyframe {
            frame: 0,
            value: Value::Position(0.0, 20.0),
            interpolation: Interpolation::Linear,
            flags: KeyframeFlags::NONE,
        });
        track.channels.insert("Position".to_string(), pos_ch);

        let mut pitch_ch = Channel::new("Pitch");
        pitch_ch.insert_keyframe(Keyframe {
            frame: 0,
            value: Value::Float(0.0),
            interpolation: Interpolation::Linear,
            flags: KeyframeFlags::NONE,
        });
        track.channels.insert("Pitch".to_string(), pitch_ch);

        let mut bearing_ch = Channel::new("Bearing");
        bearing_ch.insert_keyframe(Keyframe {
            frame: 0,
            value: Value::Float(0.0),
            interpolation: Interpolation::Linear,
            flags: KeyframeFlags::NONE,
        });
        track.channels.insert("Bearing".to_string(), bearing_ch);

        Self {
            tiles: HttpTiles::with_options(OpenStreetMap, options, cc.egui_ctx.clone()),
            map_memory: MapMemory::default(),
            track,
            current_frame: 0,
            is_playing: false,
            last_update: None,
            accumulator: 0.0,
            last_evaluated_frame: None,
            parameter_cache: HashMap::new(),
            fps: 30.0,
        }
    }

    /// The "Tick": Evaluates the animation state
    pub fn update(&mut self) {
        if self.is_playing {
            let now = std::time::Instant::now();
            let dt = if let Some(last) = self.last_update {
                now.duration_since(last).as_secs_f64()
            } else {
                0.0
            };
            self.last_update = Some(now);

            self.accumulator += dt;
            let frame_time = 1.0 / self.fps as f64;

            while self.accumulator >= frame_time {
                self.current_frame += 1;
                self.accumulator -= frame_time;
            }

            // Ensure we top out at 1800 frames based on timeline max or loop
            if self.current_frame > 1800 {
                self.current_frame = 1800;
                self.is_playing = false;
                self.last_update = None;
                self.accumulator = 0.0;
            }
        } else {
            self.last_update = None;
            self.accumulator = 0.0;
        }

        let frame_moved = self.last_evaluated_frame != Some(self.current_frame);

        // Evaluation Engine: The Solver
        for (name, channel) in &mut self.track.channels {
            // A channel is dirty if frame moved OR it was manually flagged (e.g. keyframe edited)
            if frame_moved || channel.dirty {
                let val = channel.get_value_at(self.current_frame);

                self.parameter_cache.insert(
                    name.clone(),
                    ParameterCache {
                        value: val,
                        dirty: false,
                    },
                );

                channel.dirty = false;
            }
        }

        self.last_evaluated_frame = Some(self.current_frame);

        // Sync with MapMemory (The GPU Matrix drivers)
        if let Some(cache) = self.parameter_cache.get("Zoom") {
            let _ = self.map_memory.set_zoom(cache.value.as_float());
        }

        if let Some(cache) = self.parameter_cache.get("Position") {
            let pos = cache.value.as_pos();
            self.map_memory.center_at(pos);
        }
    }

    pub fn ui(&mut self, ui: &mut egui::Ui) {
        // update() is now handled by the parent MyApp to synchronize caching.

        // Reactive Lookup: Always pull from cache unless re-solve is needed
        let _zoom = self
            .parameter_cache
            .get("Zoom")
            .map(|c| c.value.as_float())
            .unwrap_or(10.0);

        let center = self
            .parameter_cache
            .get("Position")
            .map(|c| c.value.as_pos())
            .unwrap_or(Position::new(0.0, 20.0));

        let _bearing = self
            .parameter_cache
            .get("Bearing")
            .map(|c| c.value.as_float())
            .unwrap_or(0.0);

        let _pitch = self
            .parameter_cache
            .get("Pitch")
            .map(|c| c.value.as_float())
            .unwrap_or(0.0);

        let map = Map::new(Some(&mut self.tiles), &mut self.map_memory, center).with_plugin(
            crate::map_plugin::MapHighlightPlugin {
                current_frame: self.current_frame,
                track: &self.track,
            },
        );
        ui.add(map);

        if self.is_playing {
            ui.ctx().request_repaint();
        }
    }

    pub fn zoom(&self) -> f64 {
        self.parameter_cache
            .get("Zoom")
            .map(|c| c.value.as_float())
            .unwrap_or(self.map_memory.zoom())
    }

    pub fn fit_to_location(&mut self, location: &crate::geocoding::LocationResult) {
        if location.boundingbox.len() < 4 {
            return;
        }

        // Parse bounding box: [minlat, maxlat, minlon, maxlon]
        let min_lat = location.boundingbox[0].parse::<f64>().unwrap_or(0.0);
        let max_lat = location.boundingbox[1].parse::<f64>().unwrap_or(0.0);
        let min_lon = location.boundingbox[2].parse::<f64>().unwrap_or(0.0);
        let max_lon = location.boundingbox[3].parse::<f64>().unwrap_or(0.0);

        let center_lat = (min_lat + max_lat) / 2.0;
        let center_lon = (min_lon + max_lon) / 2.0;

        let lat_span = (max_lat - min_lat).abs().max(0.001);
        let lon_span = (max_lon - min_lon).abs().max(0.001);

        // Heuristic for zoom level
        // At zoom 0, 360 degrees = 256 pixels.
        // Assume a viewport of ~1000px.
        // We want span * (256 * 2^Z / 360) < 800 (80% of viewport)
        // 2^Z < (800 * 360) / (span * 256)
        // Z < log2(1125 / span)

        let zoom_lat = (1125.0 / (lat_span * 2.0)).log2(); // lat span is more restricted
        let zoom_lon = (1125.0 / lon_span).log2();

        let target_zoom = zoom_lat.min(zoom_lon).clamp(1.0, 19.0);

        // Insert keyframes at current frame
        if let Some(ch) = self.track.channels.get_mut("Position") {
            ch.insert_keyframe(Keyframe {
                frame: self.current_frame,
                value: crate::animation::Value::Position(center_lon, center_lat),
                interpolation: Interpolation::Linear,
                flags: KeyframeFlags::NONE,
            });
        }

        if let Some(ch) = self.track.channels.get_mut("Zoom") {
            ch.insert_keyframe(Keyframe {
                frame: self.current_frame,
                value: crate::animation::Value::Float(target_zoom),
                interpolation: Interpolation::Linear,
                flags: KeyframeFlags::NONE,
            });
        }

        // Trigger a solve
        self.last_evaluated_frame = None;
    }
}
