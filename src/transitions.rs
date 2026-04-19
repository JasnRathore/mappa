use crate::animation::Value;

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum TransitionType {
    CrossFade,
    WipeLeft,
    WipeRight,
    ZoomFade,
}

pub struct Transition {
    pub start_frame: u32,
    pub end_frame: u32,
    pub transition_type: TransitionType,
}

impl Transition {
    pub fn new(start_frame: u32, end_frame: u32, transition_type: TransitionType) -> Self {
        Self {
            start_frame,
            end_frame,
            transition_type,
        }
    }

    pub fn get_progress(&self, current_frame: u32) -> f32 {
        if current_frame < self.start_frame {
            0.0
        } else if current_frame > self.end_frame {
            1.0
        } else {
            (current_frame - self.start_frame) as f32 / (self.end_frame - self.start_frame) as f32
        }
    }

    // This would be used in a compositor to blend two frames
    // For now, it's a data structure that the UI can use to show "Transition Sections"
}
