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
        handle_in: (f64, f64), // (frame_delta, value_delta)
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
        if let Some(pos) = self
            .keyframes
            .iter()
            .position(|k| k.frame == keyframe.frame)
        {
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
    pub color: [u8; 4],
    pub channels: HashMap<String, Channel>, // "Alpha", "Scale"
    pub transition_in: ClipPreset,
    pub transition_out: ClipPreset,
}
impl Clip {
    pub fn new(
        name: &str,
        start_frame: u32,
        end_frame: u32,
        location: crate::geocoding::LocationResult,
    ) -> Self {
        let mut channels = HashMap::new();

        // Alpha: 1.0 throughout by default
        let mut alpha = Channel::new("Alpha");
        alpha.insert_keyframe(Keyframe {
            frame: 0,
            value: Value::Float(1.0),
            interpolation: Interpolation::Linear,
            flags: KeyframeFlags::NONE,
        });
        channels.insert("Alpha".to_string(), alpha);

        // Scale: 1.0 throughout by default
        let mut scale = Channel::new("Scale");
        scale.insert_keyframe(Keyframe {
            frame: 0,
            value: Value::Float(1.0),
            interpolation: Interpolation::Linear,
            flags: KeyframeFlags::NONE,
        });
        channels.insert("Scale".to_string(), scale);

        Self {
            name: name.to_string(),
            start_frame,
            end_frame,
            location,
            color: [255, 140, 0, 100],
            channels,
            transition_in: ClipPreset::None,
            transition_out: ClipPreset::None,
        }
    }

    /// Frame is absolute; internally converted to relative for channel lookup
    pub fn get_param(&self, name: &str, abs_frame: u32) -> f64 {
        let rel = abs_frame.saturating_sub(self.start_frame);
        self.channels
            .get(name)
            .map(|ch| ch.get_value_at(rel).as_float())
            .unwrap_or(1.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ClipPreset {
    None,
    FadeIn,
    FadeOut,
    FadeInOut,
    PopIn,    // scale 0 → 1, ease-out
    PopOut,   // scale 1 → 0, ease-in
    BounceIn, // scale 0 → 1.15 → 1.0
    GrowFade, // scale + alpha together
}

pub fn apply_clip_preset(clip: &mut Clip, preset: ClipPreset, duration: u32) {
    let dur = duration.max(1);
    let clip_len = clip.end_frame.saturating_sub(clip.start_frame);

    match preset {
        ClipPreset::None => {
            set_flat(clip, "Alpha", 1.0);
            set_flat(clip, "Scale", 1.0);
        }

        ClipPreset::FadeIn => {
            set_ramp(clip, "Alpha", 0.0, 1.0, dur, Interpolation::EaseInOut);
            set_flat(clip, "Scale", 1.0);
        }

        ClipPreset::FadeOut => {
            let start = clip_len.saturating_sub(dur);
            set_flat(clip, "Alpha", 1.0);
            let ch = clip.channels.get_mut("Alpha").unwrap();
            ch.keyframes.clear();
            ch.insert_keyframe(kf(start, 1.0, Interpolation::EaseInOut));
            ch.insert_keyframe(kf(clip_len, 0.0, Interpolation::Linear));
            set_flat(clip, "Scale", 1.0);
        }

        ClipPreset::FadeInOut => {
            let out_start = clip_len.saturating_sub(dur);
            let ch = clip
                .channels
                .entry("Alpha".into())
                .or_insert_with(|| Channel::new("Alpha"));
            ch.keyframes.clear();
            ch.insert_keyframe(kf(0, 0.0, Interpolation::EaseInOut));
            ch.insert_keyframe(kf(dur, 1.0, Interpolation::Linear));
            ch.insert_keyframe(kf(out_start, 1.0, Interpolation::EaseInOut));
            ch.insert_keyframe(kf(clip_len, 0.0, Interpolation::Linear));
            set_flat(clip, "Scale", 1.0);
        }

        ClipPreset::PopIn => {
            set_flat(clip, "Alpha", 1.0);
            set_ramp(clip, "Scale", 0.0, 1.0, dur, Interpolation::EaseOut);
        }

        ClipPreset::PopOut => {
            set_flat(clip, "Alpha", 1.0);
            let start = clip_len.saturating_sub(dur);
            let ch = clip.channels.get_mut("Scale").unwrap();
            ch.keyframes.clear();
            ch.insert_keyframe(kf(start, 1.0, Interpolation::EaseIn));
            ch.insert_keyframe(kf(clip_len, 0.0, Interpolation::Linear));
        }

        ClipPreset::BounceIn => {
            set_flat(clip, "Alpha", 1.0);
            let ch = clip
                .channels
                .entry("Scale".into())
                .or_insert_with(|| Channel::new("Scale"));
            ch.keyframes.clear();
            ch.insert_keyframe(kf(0, 0.0, Interpolation::EaseOut));
            ch.insert_keyframe(kf(dur * 3 / 4, 1.15, Interpolation::EaseInOut));
            ch.insert_keyframe(kf(dur, 1.0, Interpolation::Linear));
        }

        ClipPreset::GrowFade => {
            set_ramp(clip, "Alpha", 0.0, 1.0, dur, Interpolation::EaseInOut);
            set_ramp(clip, "Scale", 0.0, 1.0, dur, Interpolation::EaseOut);
        }
    }
}

fn kf(frame: u32, val: f64, interp: Interpolation) -> Keyframe {
    Keyframe {
        frame,
        value: Value::Float(val),
        interpolation: interp,
        flags: KeyframeFlags::NONE,
    }
}

fn set_flat(clip: &mut Clip, name: &str, val: f64) {
    let ch = clip
        .channels
        .entry(name.into())
        .or_insert_with(|| Channel::new(name));
    ch.keyframes.clear();
    ch.insert_keyframe(kf(0, val, Interpolation::Linear));
}

fn set_ramp(clip: &mut Clip, name: &str, from: f64, to: f64, dur: u32, interp: Interpolation) {
    let ch = clip
        .channels
        .entry(name.into())
        .or_insert_with(|| Channel::new(name));
    ch.keyframes.clear();
    ch.insert_keyframe(kf(0, from, interp));
    ch.insert_keyframe(kf(dur, to, Interpolation::Linear));
}

#[derive(Clone)]
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
        self.channels
            .get(channel_name)
            .map(|c| c.get_value_at(frame))
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
