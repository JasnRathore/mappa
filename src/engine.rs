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
}

impl MapEngine {
    pub fn new(cc: &eframe::CreationContext<'_>) -> Self {
        let user_agent = HeaderValue::from_static("mappar/0.1 (paradisegamer98@gmail.com)");

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
            let frame_time = 1.0 / 30.0; // 30 FPS

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
                
                self.parameter_cache.insert(name.clone(), ParameterCache {
                    value: val,
                    dirty: false,
                });
                
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
        let zoom = self.parameter_cache.get("Zoom")
            .map(|c| c.value.as_float())
            .unwrap_or(10.0);
        
        let center = self.parameter_cache.get("Position")
            .map(|c| c.value.as_pos())
            .unwrap_or(Position::new(0.0, 20.0));

        let _bearing = self.parameter_cache.get("Bearing")
            .map(|c| c.value.as_float())
            .unwrap_or(0.0);

        let _pitch = self.parameter_cache.get("Pitch")
            .map(|c| c.value.as_float())
            .unwrap_or(0.0);

        let map = Map::new(Some(&mut self.tiles), &mut self.map_memory, center);
        ui.add(map);

        if self.is_playing {
            ui.ctx().request_repaint();
        }
    }

    pub fn zoom(&self) -> f64 {
        self.parameter_cache.get("Zoom")
            .map(|c| c.value.as_float())
            .unwrap_or(self.map_memory.zoom())
    }
}
