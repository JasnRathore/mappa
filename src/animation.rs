use std::collections::HashMap;
use walkers::Position;

bitflags::bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize)]
    pub struct KeyframeFlags: u32 {
        const NONE = 0;
        const HOLD = 1 << 0;
        const BREAK_TANGENTS = 1 << 1;
        const SELECTED = 1 << 2;
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum Value {
    Float(f64),
    Vec2(f64, f64),
    Position(f64, f64), // Lon, Lat
}

impl Value {
    pub fn as_float(&self) -> f64 {
        match self {
            Value::Float(f) => *f,
            Value::Vec2(x, _) => *x,
            Value::Position(lon, _) => *lon,
        }
    }

    pub fn as_pos(&self) -> Position {
        match self {
            Value::Position(lon, lat) => Position::new(*lon, *lat),
            _ => Position::new(0.0, 0.0),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum HandleType {
    Free,
    Aligned,
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum Interpolation {
    Linear,
    Step,
    Bezier {
        handle_in: (f64, f64),  // (frame_delta, value_delta)
        handle_out: (f64, f64),
        handle_type: HandleType,
    },
    EaseIn,
    EaseOut,
    EaseInOut,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Keyframe {
    pub frame: u32,
    pub value: Value,
    pub interpolation: Interpolation,
    pub flags: KeyframeFlags,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Channel {
    pub name: String,
    pub keyframes: Vec<Keyframe>,
    pub dirty: bool,
}

impl Channel {
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            keyframes: Vec::new(),
            dirty: true,
        }
    }

    pub fn insert_keyframe(&mut self, mut keyframe: Keyframe) {
        self.dirty = true;
        if let Some(pos) = self.keyframes.iter().position(|k| k.frame == keyframe.frame) {
            // Preserve flags if not explicitly set? 
            // For now just replace
            self.keyframes[pos] = keyframe;
        } else {
            self.keyframes.push(keyframe);
            self.keyframes.sort_by_key(|k| k.frame);
        }
    }

    pub fn get_value_at(&self, frame: u32) -> Value {
        if self.keyframes.is_empty() {
            return Value::Float(0.0);
        }

        // Binary search for the "sandwich" keyframes
        let idx = match self.keyframes.binary_search_by_key(&frame, |k| k.frame) {
            Ok(i) => return self.keyframes[i].value.clone(),
            Err(i) => i,
        };

        if idx == 0 {
            return self.keyframes[0].value.clone();
        }
        if idx >= self.keyframes.len() {
            return self.keyframes.last().unwrap().value.clone();
        }

        let prev = &self.keyframes[idx - 1];
        let next = &self.keyframes[idx];

        if prev.flags.contains(KeyframeFlags::HOLD) {
            return prev.value.clone();
        }

        let t = (frame - prev.frame) as f64 / (next.frame - prev.frame) as f64;
        interpolate_value(&prev.value, &next.value, t, prev.interpolation, prev, next)
    }
}

pub struct Track {
    pub name: String,
    pub channels: HashMap<String, Channel>,
    pub object_tracks: Vec<ObjectTrack>,
}

#[derive(Debug, Clone)]
pub struct Clip {
    pub name: String,
    pub start_frame: u32,
    pub end_frame: u32,
    pub location: crate::geocoding::LocationResult,
}

pub struct ObjectTrack {
    pub name: String,
    pub clips: Vec<Clip>,
}

impl ObjectTrack {
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            clips: Vec::new(),
        }
    }
}

impl Track {
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            channels: HashMap::new(),
            object_tracks: Vec::new(),
        }
    }

    pub fn get_channel_value(&self, channel_name: &str, frame: u32) -> Option<Value> {
        self.channels.get(channel_name).map(|c| c.get_value_at(frame))
    }
}

fn interpolate_value(
    v1: &Value,
    v2: &Value,
    t: f64,
    interp: Interpolation,
    _p_kf: &Keyframe,
    _n_kf: &Keyframe,
) -> Value {
    let t_adj = match interp {
        Interpolation::Linear => t,
        Interpolation::Step => 0.0,
        Interpolation::EaseIn => t * t * t,
        Interpolation::EaseOut => 1.0 - (1.0 - t).powi(3),
        Interpolation::EaseInOut => {
            if t < 0.5 {
                4.0 * t * t * t
            } else {
                1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
            }
        }
        Interpolation::Bezier {
            handle_out,
            handle_in,
            ..
        } => {
            // Cubic Bezier calculation using normalized handles
            // In a real engine, we'd solve for t given x (time)
            // But here we use the provided blend equation for simplicity as requested
            // V(t) = (1-t)^3*P0 + 3(1-t)^2*t*P1 + 3(1-t)*t^2*P2 + t^3*P3
            
            // P0 = 0.0, P3 = 1.0
            // P1 and P2 are influenced by handle_out.1 and handle_in.1 (value deltas)
            // Normalized handle influence:
            let p1 = handle_out.1; 
            let p2 = 1.0 + handle_in.1; 
            
            cubic_bezier_sample(0.0, p1, p2, 1.0, t)
        }
    };

    match (v1, v2) {
        (Value::Float(f1), Value::Float(f2)) => Value::Float(f1 + (f2 - f1) * t_adj),
        (Value::Position(lon1, lat1), Value::Position(lon2, lat2)) => {
            Value::Position(lon1 + (lon2 - lon1) * t_adj, lat1 + (lat2 - lat1) * t_adj)
        }
        (Value::Vec2(x1, y1), Value::Vec2(x2, y2)) => {
            Value::Vec2(x1 + (x2 - x1) * t_adj, y1 + (y2 - y1) * t_adj)
        }
        _ => v1.clone(),
    }
}

fn cubic_bezier_sample(p0: f64, p1: f64, p2: f64, p3: f64, t: f64) -> f64 {
    let it = 1.0 - t;
    it * it * it * p0 + 3.0 * it * it * t * p1 + 3.0 * it * t * t * p2 + t * t * t * p3
}
