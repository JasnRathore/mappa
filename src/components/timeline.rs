use crate::animation::{Channel, ObjectTrack};
use crate::engine::MapEngine;
use eframe::egui::{self, Color32, Painter, Pos2, Rect, Stroke, Vec2};
use std::collections::HashMap;
// ─────────────────────────────────────────────────────────────────────────────
//  Edit Modes
// ─────────────────────────────────────────────────────────────────────────────

/// Controls how a dragged location is placed onto the timeline.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum EditMode {
    /// Place clip at the drop position; existing clips are left in place.
    Overwrite,
    /// Insert at drop position, ripple-shifting all later clips to the right.
    Insert,
    /// Always append after the last clip in the target track.
    Append,
    /// Swap the location data of the currently selected clip (timing unchanged).
    Replace,
}

// ─────────────────────────────────────────────────────────────────────────────
//  Snap Settings
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SnapSettings {
    pub enabled: bool,
    pub to_playhead: bool,
    pub to_keyframes: bool,
    pub to_clip_edges: bool,
    pub to_markers: bool,
    /// Pixel distance within which snapping activates.
    pub threshold_px: f32,
}

impl Default for SnapSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            to_playhead: true,
            to_keyframes: true,
            to_clip_edges: true,
            to_markers: true,
            threshold_px: 8.0,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Markers
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct Marker {
    pub frame: u32,
    pub color: Color32,
    pub note: String,
}

impl Marker {
    pub fn new(frame: u32) -> Self {
        Self {
            frame,
            color: Color32::from_rgb(220, 180, 40),
            note: String::new(),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Trim Handle
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TrimSide {
    In,
    Out,
}

#[derive(Debug, Clone, Copy)]
struct TrimDrag {
    track_idx: usize,
    clip_idx: usize,
    side: TrimSide,
}

// ─────────────────────────────────────────────────────────────────────────────
//  Undo / Redo Snapshot
// ─────────────────────────────────────────────────────────────────────────────

/// Lightweight snapshot of the mutable timeline state.
/// Both `Vec<ObjectTrack>` and `HashMap<String, Channel>` are Clone.
struct TimelineSnapshot {
    object_tracks: Vec<ObjectTrack>,
    channels: HashMap<String, Channel>,
}

// ─────────────────────────────────────────────────────────────────────────────
//  Context-menu action (deferred so we don't hold borrows while mutating)
// ─────────────────────────────────────────────────────────────────────────────

enum ContextAction {
    Delete(usize, usize),
    RippleDelete(usize, usize),
    TrimInToPlayhead(usize, usize),
    TrimOutToPlayhead(usize, usize),
    AddMarkerHere(u32),
}

// ─────────────────────────────────────────────────────────────────────────────
//  Timeline
// ─────────────────────────────────────────────────────────────────────────────

pub struct Timeline {
    // ── Layout ───────────────────────────────────────────────────────────────
    pub pan_x: f32,
    pub zoom_x: f32,
    pub track_height: f32,
    pub sidebar_width: f32,

    // ── Drag state ───────────────────────────────────────────────────────────
    pub dragging_kf: Option<(String, usize)>,
    trim_drag: Option<TrimDrag>,

    // ── Features ─────────────────────────────────────────────────────────────
    pub edit_mode: EditMode,
    pub snap: SnapSettings,
    pub markers: Vec<Marker>,

    // ── Undo / Redo ───────────────────────────────────────────────────────────
    undo_stack: Vec<TimelineSnapshot>,
    redo_stack: Vec<TimelineSnapshot>,
}

impl Timeline {
    pub fn new() -> Self {
        Self {
            pan_x: 20.0,
            zoom_x: 2.0,
            track_height: 30.0,
            sidebar_width: 100.0,
            dragging_kf: None,
            trim_drag: None,
            edit_mode: EditMode::Overwrite,
            snap: SnapSettings::default(),
            markers: Vec::new(),
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
        }
    }

    // ── Undo / Redo ───────────────────────────────────────────────────────────

    fn push_undo(&mut self, engine: &MapEngine) {
        self.undo_stack.push(TimelineSnapshot {
            object_tracks: engine.track.object_tracks.clone(),
            channels: engine.track.channels.clone(),
        });
        if self.undo_stack.len() > 50 {
            self.undo_stack.remove(0);
        }
        self.redo_stack.clear();
    }

    pub fn undo(&mut self, engine: &mut MapEngine) {
        if let Some(snap) = self.undo_stack.pop() {
            self.redo_stack.push(TimelineSnapshot {
                object_tracks: engine.track.object_tracks.clone(),
                channels: engine.track.channels.clone(),
            });
            engine.track.object_tracks = snap.object_tracks;
            engine.track.channels = snap.channels;
            engine.last_evaluated_frame = None;
        }
    }

    pub fn redo(&mut self, engine: &mut MapEngine) {
        if let Some(snap) = self.redo_stack.pop() {
            self.undo_stack.push(TimelineSnapshot {
                object_tracks: engine.track.object_tracks.clone(),
                channels: engine.track.channels.clone(),
            });
            engine.track.object_tracks = snap.object_tracks;
            engine.track.channels = snap.channels;
            engine.last_evaluated_frame = None;
        }
    }

    // ── Snapping ──────────────────────────────────────────────────────────────

    /// Snap `frame` to the nearest snap point within `threshold_px` pixels.
    /// `exclude_clip` prevents a clip from snapping to itself.
    fn snap_frame(
        &self,
        frame: u32,
        engine: &MapEngine,
        exclude_clip: Option<(usize, usize)>,
    ) -> u32 {
        if !self.snap.enabled {
            return frame;
        }
        let frame_px = frame as f32 * self.zoom_x;
        let thr = self.snap.threshold_px;
        let mut best = frame;
        let mut best_dist = thr + 1.0;

        let mut try_snap = |candidate: u32| {
            let d = ((candidate as f32 * self.zoom_x) - frame_px).abs();
            if d < thr && d < best_dist {
                best_dist = d;
                best = candidate;
            }
        };

        if self.snap.to_playhead {
            try_snap(engine.current_frame);
        }
        if self.snap.to_markers {
            for m in &self.markers {
                try_snap(m.frame);
            }
        }
        if self.snap.to_keyframes {
            for ch in engine.track.channels.values() {
                for kf in &ch.keyframes {
                    try_snap(kf.frame);
                }
            }
        }
        if self.snap.to_clip_edges {
            for (ti, ot) in engine.track.object_tracks.iter().enumerate() {
                for (ci, clip) in ot.clips.iter().enumerate() {
                    if exclude_clip == Some((ti, ci)) {
                        continue;
                    }
                    try_snap(clip.start_frame);
                    try_snap(clip.end_frame);
                }
            }
        }
        best
    }

    // ── Clip Operations ───────────────────────────────────────────────────────

    /// Append: add clip after the last clip in the target track (or new track).
    pub fn append_clip(
        &mut self,
        engine: &mut MapEngine,
        loc: crate::geocoding::LocationResult,
        track_idx: Option<usize>,
        duration: u32,
    ) {
        self.push_undo(engine);
        let ti = track_idx.unwrap_or_else(|| {
            let n = engine.track.object_tracks.len();
            engine
                .track
                .object_tracks
                .push(crate::animation::ObjectTrack::new(&format!(
                    "Location {}",
                    n + 1
                )));
            n
        });
        let start = engine.track.object_tracks[ti]
            .clips
            .last()
            .map(|c| c.end_frame + 1)
            .unwrap_or(0);
        let clip =
            crate::animation::Clip::new(&loc.display_name.clone(), start, start + duration, loc);
        engine.track.object_tracks[ti].clips.push(clip);
    }

    /// Insert: place clip at `at_frame`, ripple-shift all clips starting ≥ that frame right.
    pub fn insert_clip(
        &mut self,
        engine: &mut MapEngine,
        loc: crate::geocoding::LocationResult,
        track_idx: usize,
        at_frame: u32,
        duration: u32,
    ) {
        self.push_undo(engine);
        if let Some(ot) = engine.track.object_tracks.get_mut(track_idx) {
            for clip in ot.clips.iter_mut() {
                if clip.start_frame >= at_frame {
                    clip.start_frame += duration;
                    clip.end_frame += duration;
                }
            }
            let clip = crate::animation::Clip::new(
                &loc.display_name.clone(),
                at_frame,
                at_frame + duration,
                loc,
            );
            ot.clips.push(clip);
            ot.clips.sort_by_key(|c| c.start_frame);
        }
    }

    /// Overwrite: place clip at `at_frame` without shifting anything.
    pub fn overwrite_clip(
        &mut self,
        engine: &mut MapEngine,
        loc: crate::geocoding::LocationResult,
        track_idx: usize,
        at_frame: u32,
        duration: u32,
    ) {
        self.push_undo(engine);
        if let Some(ot) = engine.track.object_tracks.get_mut(track_idx) {
            let clip = crate::animation::Clip::new(
                &loc.display_name.clone(),
                at_frame,
                at_frame + duration,
                loc,
            );
            ot.clips.push(clip);
            ot.clips.sort_by_key(|c| c.start_frame);
        }
    }

    /// Replace: swap the location of an existing clip without touching its timing.
    pub fn replace_clip(
        &mut self,
        engine: &mut MapEngine,
        track_idx: usize,
        clip_idx: usize,
        new_loc: crate::geocoding::LocationResult,
    ) {
        self.push_undo(engine);
        if let Some(clip) = engine
            .track
            .object_tracks
            .get_mut(track_idx)
            .and_then(|t| t.clips.get_mut(clip_idx))
        {
            clip.name = new_loc.display_name.clone();
            clip.location = new_loc;
        }
    }

    /// Delete clip; no ripple.
    pub fn delete_clip(&mut self, engine: &mut MapEngine, track_idx: usize, clip_idx: usize) {
        self.push_undo(engine);
        if let Some(ot) = engine.track.object_tracks.get_mut(track_idx) {
            if clip_idx < ot.clips.len() {
                ot.clips.remove(clip_idx);
            }
        }
    }

    /// Ripple delete: remove clip and shift all subsequent clips on the same track left.
    pub fn ripple_delete(&mut self, engine: &mut MapEngine, track_idx: usize, clip_idx: usize) {
        // Check bounds before taking a mutable borrow of `engine`.
        if track_idx >= engine.track.object_tracks.len() {
            return;
        }
        if clip_idx >= engine.track.object_tracks[track_idx].clips.len() {
            return;
        }
        // Safe to push undo now (immutable borrow) because we don't yet hold a mutable borrow.
        self.push_undo(engine);
        if let Some(ot) = engine.track.object_tracks.get_mut(track_idx) {
            let removed = ot.clips.remove(clip_idx);
            let gap = removed.end_frame.saturating_sub(removed.start_frame) + 1;
            for clip in ot.clips.iter_mut() {
                if clip.start_frame > removed.start_frame {
                    clip.start_frame = clip.start_frame.saturating_sub(gap);
                    clip.end_frame = clip.end_frame.saturating_sub(gap);
                }
            }
        }
    }

    // ── Precision Trimming ────────────────────────────────────────────────────

    /// Set clip in-point to current playhead position.
    pub fn trim_in_to_playhead(
        &mut self,
        engine: &mut MapEngine,
        track_idx: usize,
        clip_idx: usize,
    ) {
        self.push_undo(engine);
        if let Some(clip) = engine
            .track
            .object_tracks
            .get_mut(track_idx)
            .and_then(|t| t.clips.get_mut(clip_idx))
        {
            if engine.current_frame < clip.end_frame {
                clip.start_frame = engine.current_frame;
            }
        }
    }

    /// Set clip out-point to current playhead position.
    pub fn trim_out_to_playhead(
        &mut self,
        engine: &mut MapEngine,
        track_idx: usize,
        clip_idx: usize,
    ) {
        self.push_undo(engine);
        if let Some(clip) = engine
            .track
            .object_tracks
            .get_mut(track_idx)
            .and_then(|t| t.clips.get_mut(clip_idx))
        {
            if engine.current_frame > clip.start_frame {
                clip.end_frame = engine.current_frame;
            }
        }
    }

    /// Roll edit: move the shared boundary between clip `clip_idx` and clip `clip_idx+1`
    /// by `delta_frames` (positive = extend left clip, shrink right clip).
    pub fn roll_edit(
        &mut self,
        engine: &mut MapEngine,
        track_idx: usize,
        clip_idx: usize,
        delta_frames: i32,
    ) {
        self.push_undo(engine);
        if let Some(ot) = engine.track.object_tracks.get_mut(track_idx) {
            let next_idx = clip_idx + 1;
            if next_idx >= ot.clips.len() {
                return;
            }
            let new_out = (ot.clips[clip_idx].end_frame as i32 + delta_frames)
                .max(ot.clips[clip_idx].start_frame as i32 + 1) as u32;
            let new_in = (ot.clips[next_idx].start_frame as i32 + delta_frames).max(0) as u32;
            if new_in >= ot.clips[next_idx].end_frame {
                return;
            }
            ot.clips[clip_idx].end_frame = new_out;
            ot.clips[next_idx].start_frame = new_in;
        }
    }

    // ── Markers ───────────────────────────────────────────────────────────────

    pub fn add_marker(&mut self, frame: u32) {
        if !self.markers.iter().any(|m| m.frame == frame) {
            self.markers.push(Marker::new(frame));
            self.markers.sort_by_key(|m| m.frame);
        }
    }

    pub fn remove_marker(&mut self, frame: u32) {
        self.markers.retain(|m| m.frame != frame);
    }

    pub fn jump_to_next_marker(&self, engine: &mut MapEngine) {
        if let Some(m) = self.markers.iter().find(|m| m.frame > engine.current_frame) {
            engine.current_frame = m.frame;
        }
    }

    pub fn jump_to_prev_marker(&self, engine: &mut MapEngine) {
        if let Some(m) = self
            .markers
            .iter()
            .rev()
            .find(|m| m.frame < engine.current_frame)
        {
            engine.current_frame = m.frame;
        }
    }

    // ── Edit-point navigation ─────────────────────────────────────────────────

    pub fn jump_to_next_edit_point(&self, engine: &mut MapEngine) {
        let cur = engine.current_frame;
        let mut best: Option<u32> = None;
        for ot in &engine.track.object_tracks {
            for clip in &ot.clips {
                for &edge in &[clip.start_frame, clip.end_frame] {
                    if edge > cur {
                        best = Some(best.map_or(edge, |b: u32| b.min(edge)));
                    }
                }
            }
        }
        if let Some(f) = best {
            engine.current_frame = f;
        }
    }

    pub fn jump_to_prev_edit_point(&self, engine: &mut MapEngine) {
        let cur = engine.current_frame;
        let mut best: Option<u32> = None;
        for ot in &engine.track.object_tracks {
            for clip in &ot.clips {
                for &edge in &[clip.start_frame, clip.end_frame] {
                    if edge < cur {
                        best = Some(best.map_or(edge, |b: u32| b.max(edge)));
                    }
                }
            }
        }
        if let Some(f) = best {
            engine.current_frame = f;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Main UI
    // ─────────────────────────────────────────────────────────────────────────

    pub fn ui(
        &mut self,
        ui: &mut egui::Ui,
        engine: &mut MapEngine,
        dragging_location: &Option<crate::geocoding::LocationResult>,
        selected_clip: &mut Option<(usize, usize)>,
    ) -> bool {
        let mut dropped = false;

        // ── Toolbar ───────────────────────────────────────────────────────────
        self.draw_toolbar(ui, engine, selected_clip);
        ui.separator();

        // ── Allocate the main canvas ──────────────────────────────────────────
        let available_size = ui.available_size();
        let (rect, response) = ui.allocate_at_least(available_size, egui::Sense::click_and_drag());
        let painter = ui.painter_at(rect);

        // Sidebar background
        let sidebar_rect = Rect::from_min_max(
            rect.min,
            Pos2::new(rect.min.x + self.sidebar_width, rect.max.y),
        );
        painter.rect_filled(sidebar_rect, 0.0, Color32::from_gray(35));

        // Main timeline background
        let timeline_rect = Rect::from_min_max(Pos2::new(sidebar_rect.max.x, rect.min.y), rect.max);
        painter.rect_filled(timeline_rect, 0.0, Color32::from_gray(25));

        // ── Ruler ─────────────────────────────────────────────────────────────
        let ruler_height = 28.0;
        let ruler_rect = Rect::from_min_max(
            timeline_rect.min,
            Pos2::new(timeline_rect.max.x, timeline_rect.min.y + ruler_height),
        );
        painter.rect_filled(ruler_rect, 0.0, Color32::from_gray(42));
        self.draw_ruler(&painter, ruler_rect);

        // ── Tracks ────────────────────────────────────────────────────────────
        let tracks_rect = Rect::from_min_max(
            Pos2::new(timeline_rect.min.x, ruler_rect.max.y),
            timeline_rect.max,
        );

        let mut track_v_offset = tracks_rect.min.y;
        let channel_names = ["Zoom", "Position", "Bearing", "Pitch"];

        for name in &channel_names {
            let ch_rect = Rect::from_min_max(
                Pos2::new(rect.min.x, track_v_offset),
                Pos2::new(rect.max.x, track_v_offset + self.track_height),
            );
            self.draw_track_label(&painter, ch_rect, name);
            painter.line_segment(
                [
                    Pos2::new(rect.min.x, ch_rect.max.y),
                    Pos2::new(rect.max.x, ch_rect.max.y),
                ],
                Stroke::new(1.0, Color32::from_gray(40)),
            );
            if let Some(ch) = engine.track.channels.get_mut(*name) {
                self.draw_track_keyframes(&painter, ch_rect, ch, ui, engine.current_frame);
            }
            track_v_offset += self.track_height;
        }

        // ── Object Tracks ─────────────────────────────────────────────────────
        let mut snap_loc: Option<crate::geocoding::LocationResult> = None;
        let mut deferred: Option<ContextAction> = None;

        let obj_track_count = engine.track.object_tracks.len();
        for track_idx in 0..obj_track_count {
            let ch_rect = Rect::from_min_max(
                Pos2::new(rect.min.x, track_v_offset),
                Pos2::new(rect.max.x, track_v_offset + self.track_height),
            );
            let track_name = engine.track.object_tracks[track_idx].name.clone();
            self.draw_track_label(&painter, ch_rect, &track_name);
            painter.line_segment(
                [
                    Pos2::new(rect.min.x, ch_rect.max.y),
                    Pos2::new(rect.max.x, ch_rect.max.y),
                ],
                Stroke::new(1.0, Color32::from_gray(40)),
            );

            if let Some(loc) = self.draw_object_clips(
                &painter,
                ch_rect,
                engine,
                ui,
                track_idx,
                selected_clip,
                &mut deferred,
            ) {
                snap_loc = Some(loc);
            }

            track_v_offset += self.track_height;
        }

        // ── Execute deferred context actions (avoids borrow conflicts) ─────────
        if let Some(action) = deferred {
            match action {
                ContextAction::Delete(ti, ci) => {
                    self.delete_clip(engine, ti, ci);
                    if *selected_clip == Some((ti, ci)) {
                        *selected_clip = None;
                    }
                }
                ContextAction::RippleDelete(ti, ci) => {
                    self.ripple_delete(engine, ti, ci);
                    if *selected_clip == Some((ti, ci)) {
                        *selected_clip = None;
                    }
                }
                ContextAction::TrimInToPlayhead(ti, ci) => {
                    self.trim_in_to_playhead(engine, ti, ci);
                }
                ContextAction::TrimOutToPlayhead(ti, ci) => {
                    self.trim_out_to_playhead(engine, ti, ci);
                }
                ContextAction::AddMarkerHere(frame) => {
                    self.add_marker(frame);
                }
            }
        }

        if let Some(loc) = snap_loc {
            engine.fit_to_location(&loc);
        }

        // ── Drop Handling ─────────────────────────────────────────────────────
        if let Some(loc) = dragging_location {
            if ui.rect_contains_pointer(rect) {
                painter.rect_filled(
                    tracks_rect,
                    0.0,
                    Color32::from_rgba_premultiplied(0, 100, 200, 25),
                );
                painter.rect_stroke(
                    tracks_rect,
                    0.0,
                    Stroke::new(2.0, Color32::from_rgb(0, 150, 255)),
                    eframe::egui::StrokeKind::Middle,
                );
                ui.ctx().set_cursor_icon(egui::CursorIcon::Copy);
            }

            let released = ui.input(|i| i.pointer.any_released());
            let ptr_pos = ui.input(|i| i.pointer.interact_pos().or(i.pointer.hover_pos()));

            if released {
                if let Some(ptr_pos) = ptr_pos {
                    if rect.contains(ptr_pos) {
                        let raw_frame = ((ptr_pos.x - timeline_rect.left() - self.pan_x)
                            / self.zoom_x)
                            .max(0.0) as u32;
                        let frame = self.snap_frame(raw_frame, engine, None);

                        let row_y = (ptr_pos.y - ruler_rect.max.y) / self.track_height;
                        let param_count = channel_names.len() as isize;
                        let clicked_idx = row_y.floor() as isize - param_count;

                        let duration = 90u32;

                        let ensure_track = |engine: &mut MapEngine, idx: isize| -> usize {
                            if idx >= 0 && (idx as usize) < engine.track.object_tracks.len() {
                                idx as usize
                            } else {
                                let n = engine.track.object_tracks.len();
                                engine.track.object_tracks.push(
                                    crate::animation::ObjectTrack::new(&format!(
                                        "Location {}",
                                        n + 1
                                    )),
                                );
                                n
                            }
                        };

                        match self.edit_mode {
                            EditMode::Append => {
                                let ti = if clicked_idx >= 0
                                    && (clicked_idx as usize) < engine.track.object_tracks.len()
                                {
                                    Some(clicked_idx as usize)
                                } else {
                                    None
                                };
                                self.append_clip(engine, loc.clone(), ti, duration);
                            }
                            EditMode::Insert => {
                                let ti = ensure_track(engine, clicked_idx);
                                self.insert_clip(engine, loc.clone(), ti, frame, duration);
                            }
                            EditMode::Replace => {
                                if let Some((ti, ci)) = *selected_clip {
                                    self.replace_clip(engine, ti, ci, loc.clone());
                                } else {
                                    let ti = ensure_track(engine, clicked_idx);
                                    self.overwrite_clip(engine, loc.clone(), ti, frame, duration);
                                }
                            }
                            EditMode::Overwrite => {
                                let ti = ensure_track(engine, clicked_idx);
                                self.overwrite_clip(engine, loc.clone(), ti, frame, duration);
                            }
                        }
                        dropped = true;
                    }
                }
            }
        }

        // ── Marker vertical lines (drawn above tracks, below playhead) ─────────
        self.draw_marker_lines(&painter, ruler_rect, tracks_rect);

        // ── Playhead ──────────────────────────────────────────────────────────
        self.draw_playhead(&painter, timeline_rect, ruler_rect, engine);

        // ── Snap indicator: highlight the snapped position while dragging ──────
        self.draw_snap_indicator(&painter, timeline_rect, engine);

        // ── Input ─────────────────────────────────────────────────────────────
        self.handle_input(
            ui,
            response,
            timeline_rect,
            ruler_rect,
            engine,
            selected_clip,
        );

        dropped
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Toolbar
    // ─────────────────────────────────────────────────────────────────────────

    fn draw_toolbar(
        &mut self,
        ui: &mut egui::Ui,
        engine: &mut MapEngine,
        selected_clip: &mut Option<(usize, usize)>,
    ) {
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 3.0;

            // ── Undo / Redo ───────────────────────────────────────────────────
            if ui
                .add_enabled(!self.undo_stack.is_empty(), egui::Button::new("↩"))
                .on_hover_text("Undo  Ctrl+Z")
                .clicked()
            {
                self.undo(engine);
            }
            if ui
                .add_enabled(!self.redo_stack.is_empty(), egui::Button::new("↪"))
                .on_hover_text("Redo  Ctrl+Y")
                .clicked()
            {
                self.redo(engine);
            }

            ui.separator();

            // ── Edit Mode ─────────────────────────────────────────────────────
            ui.label("Edit:");
            for &(mode, label, tip) in &[
                (
                    EditMode::Overwrite,
                    "OW",
                    "Overwrite – place clip at drop position",
                ),
                (
                    EditMode::Insert,
                    "INS",
                    "Insert – ripple-shift existing clips right",
                ),
                (
                    EditMode::Append,
                    "APP",
                    "Append – add after last clip in track",
                ),
                (
                    EditMode::Replace,
                    "REP",
                    "Replace – swap selected clip's location",
                ),
            ] {
                let active = self.edit_mode == mode;
                let btn = egui::Button::new(label).fill(if active {
                    Color32::from_rgb(181, 53, 42)
                } else {
                    Color32::from_gray(42)
                });
                if ui.add(btn).on_hover_text(tip).clicked() {
                    self.edit_mode = mode;
                }
            }

            ui.separator();

            // ── Snap Toggle ───────────────────────────────────────────────────
            let snap_btn = egui::Button::new("⊕ Snap").fill(if self.snap.enabled {
                Color32::from_rgb(30, 120, 40)
            } else {
                Color32::from_gray(42)
            });
            if ui
                .add(snap_btn)
                .on_hover_text("Toggle snapping  S")
                .clicked()
            {
                self.snap.enabled = !self.snap.enabled;
            }

            ui.separator();

            // ── Playback controls ─────────────────────────────────────────────
            if ui.button("|◀").on_hover_text("Go to start  Home").clicked() {
                engine.current_frame = 0;
            }
            if ui
                .button("⏮")
                .on_hover_text("Previous edit point  Shift+←")
                .clicked()
            {
                self.jump_to_prev_edit_point(engine);
            }
            if ui
                .button("◀")
                .on_hover_text("Step back one frame  ←")
                .clicked()
            {
                engine.current_frame = engine.current_frame.saturating_sub(1);
            }
            let play_icon = if engine.is_playing { "⏸" } else { "▶" };
            if ui
                .button(play_icon)
                .on_hover_text("Play / Pause  Space")
                .clicked()
            {
                engine.is_playing = !engine.is_playing;
            }
            if ui
                .button("▶")
                .on_hover_text("Step forward one frame  →")
                .clicked()
            {
                engine.current_frame = (engine.current_frame + 1).min(1800);
            }
            if ui
                .button("⏭")
                .on_hover_text("Next edit point  Shift+→")
                .clicked()
            {
                self.jump_to_next_edit_point(engine);
            }

            ui.separator();

            // ── Marker controls ───────────────────────────────────────────────
            if ui
                .button("🏳 M")
                .on_hover_text("Add marker at playhead  M")
                .clicked()
            {
                self.add_marker(engine.current_frame);
            }
            if ui
                .button("◀●")
                .on_hover_text("Jump to previous marker")
                .clicked()
            {
                self.jump_to_prev_marker(engine);
            }
            if ui
                .button("●▶")
                .on_hover_text("Jump to next marker")
                .clicked()
            {
                self.jump_to_next_marker(engine);
            }

            ui.separator();

            // ── Trim / Delete (only shown when a clip is selected) ─────────────
            if let Some((ti, ci)) = *selected_clip {
                if ui
                    .button("⊢ I")
                    .on_hover_text("Trim In to playhead")
                    .clicked()
                {
                    self.trim_in_to_playhead(engine, ti, ci);
                }
                if ui
                    .button("O ⊣")
                    .on_hover_text("Trim Out to playhead")
                    .clicked()
                {
                    self.trim_out_to_playhead(engine, ti, ci);
                }
                if ui
                    .button("✂ Ripple")
                    .on_hover_text("Ripple delete selected clip  Delete")
                    .clicked()
                {
                    self.ripple_delete(engine, ti, ci);
                    *selected_clip = None;
                }
            }

            // ── Right-side: timecode + zoom slider ────────────────────────────
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                // Zoom slider
                ui.label("Zoom:");
                let mut zoom = self.zoom_x;
                if ui
                    .add(
                        egui::Slider::new(&mut zoom, 0.1..=50.0)
                            .logarithmic(true)
                            .show_value(false)
                            .clamp_to_range(true),
                    )
                    .changed()
                {
                    self.zoom_x = zoom;
                }

                ui.separator();

                // Timecode display  MM:SS:FF
                let fps = 30u32;
                let total_secs = engine.current_frame / fps;
                let frames = engine.current_frame % fps;
                let secs = total_secs % 60;
                let mins = total_secs / 60;
                ui.label(
                    egui::RichText::new(format!("{:02}:{:02}:{:02}", mins, secs, frames))
                        .monospace()
                        .color(Color32::from_rgb(200, 200, 200)),
                );
            });
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Ruler
    // ─────────────────────────────────────────────────────────────────────────

    fn draw_ruler(&self, painter: &Painter, rect: Rect) {
        // Choose tick spacing based on zoom level
        let frame_step = if self.zoom_x < 0.5 {
            200
        } else if self.zoom_x < 1.0 {
            100
        } else if self.zoom_x < 5.0 {
            50
        } else {
            10
        };

        let start_frame = ((-self.pan_x) / self.zoom_x).floor() as i32;
        let end_frame = ((rect.width() - self.pan_x) / self.zoom_x).ceil() as i32;

        for f in (start_frame.max(0)..end_frame).step_by(frame_step.max(1) as usize) {
            let x = rect.left() + self.pan_x + f as f32 * self.zoom_x;
            if x < rect.left() || x > rect.right() {
                continue;
            }
            let is_major = f % (frame_step * 5) as i32 == 0;
            let tick_h = if is_major { 9.0 } else { 4.0 };
            painter.line_segment(
                [
                    Pos2::new(x, rect.bottom() - tick_h),
                    Pos2::new(x, rect.bottom()),
                ],
                Stroke::new(1.0, Color32::GRAY),
            );
            // Label only at major ticks or when zoomed in enough
            if is_major || self.zoom_x >= 3.0 {
                painter.text(
                    Pos2::new(x, rect.top() + 4.0),
                    egui::Align2::CENTER_TOP,
                    f.to_string(),
                    egui::FontId::proportional(10.0),
                    Color32::from_gray(150),
                );
            }
        }

        // Marker flags on ruler
        for marker in &self.markers {
            let x = rect.left() + self.pan_x + marker.frame as f32 * self.zoom_x;
            if x < rect.left() || x > rect.right() {
                continue;
            }
            // Small downward triangle flag
            let pts = vec![
                Pos2::new(x, rect.top() + 2.0),
                Pos2::new(x + 8.0, rect.top() + 2.0),
                Pos2::new(x, rect.top() + 10.0),
            ];
            painter.add(egui::Shape::convex_polygon(pts, marker.color, Stroke::NONE));

            // Optionally show note
            if !marker.note.is_empty() && self.zoom_x > 2.0 {
                painter.text(
                    Pos2::new(x + 10.0, rect.top() + 4.0),
                    egui::Align2::LEFT_TOP,
                    &marker.note,
                    egui::FontId::proportional(9.0),
                    marker.color,
                );
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Marker vertical lines through tracks
    // ─────────────────────────────────────────────────────────────────────────

    fn draw_marker_lines(&self, painter: &Painter, ruler_rect: Rect, tracks_rect: Rect) {
        for marker in &self.markers {
            let x = ruler_rect.left() + self.pan_x + marker.frame as f32 * self.zoom_x;
            if x < ruler_rect.left() || x > ruler_rect.right() {
                continue;
            }
            painter.line_segment(
                [
                    Pos2::new(x, ruler_rect.bottom()),
                    Pos2::new(x, tracks_rect.bottom()),
                ],
                Stroke::new(1.0, marker.color.linear_multiply(0.45)),
            );
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Sidebar label helper
    // ─────────────────────────────────────────────────────────────────────────

    fn draw_track_label(&self, painter: &Painter, rect: Rect, name: &str) {
        painter.text(
            Pos2::new(rect.min.x + 8.0, rect.min.y + rect.height() / 2.0),
            egui::Align2::LEFT_CENTER,
            name,
            egui::FontId::proportional(11.0),
            Color32::from_gray(160),
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Channel keyframes row
    // ─────────────────────────────────────────────────────────────────────────

    fn draw_track_keyframes(
        &mut self,
        painter: &Painter,
        rect: Rect,
        channel: &mut Channel,
        ui: &mut egui::Ui,
        current_frame: u32,
    ) {
        for i in 0..channel.keyframes.len() {
            let kf = &channel.keyframes[i];
            let x = rect.left() + self.sidebar_width + self.pan_x + kf.frame as f32 * self.zoom_x;
            if x < rect.left() + self.sidebar_width || x > rect.right() {
                continue;
            }

            let pos = Pos2::new(x, rect.center().y);
            let is_current = kf.frame == current_frame;
            let color = if is_current {
                Color32::from_rgb(255, 128, 0)
            } else {
                Color32::from_rgb(180, 180, 180)
            };

            let size = 5.0;
            let diamond = vec![
                pos + Vec2::new(0.0, -size),
                pos + Vec2::new(size, 0.0),
                pos + Vec2::new(0.0, size),
                pos + Vec2::new(-size, 0.0),
            ];
            painter.add(egui::Shape::convex_polygon(diamond, color, Stroke::NONE));

            let kf_rect = Rect::from_center_size(pos, Vec2::splat(12.0));
            let kf_resp = ui.interact(
                kf_rect,
                ui.id().with(&channel.name).with(i),
                egui::Sense::drag(),
            );

            if kf_resp.dragged() {
                self.dragging_kf = Some((channel.name.clone(), i));
                let frame_delta = (kf_resp.drag_delta().x / self.zoom_x).round() as i32;
                if frame_delta != 0 {
                    channel.keyframes[i].frame =
                        (channel.keyframes[i].frame as i32 + frame_delta).max(0) as u32;
                    channel.dirty = true;
                }
            }
        }

        if channel.dirty {
            channel.keyframes.sort_by_key(|k| k.frame);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Object clips with trim handles
    // ─────────────────────────────────────────────────────────────────────────

    fn draw_object_clips(
        &mut self,
        painter: &Painter,
        rect: Rect,
        engine: &mut MapEngine,
        ui: &mut egui::Ui,
        track_idx: usize,
        selected_clip: &mut Option<(usize, usize)>,
        deferred: &mut Option<ContextAction>,
    ) -> Option<crate::geocoding::LocationResult> {
        let mut action_loc: Option<crate::geocoding::LocationResult> = None;
        let trim_w = 8.0_f32;
        let clip_count = engine.track.object_tracks[track_idx].clips.len();

        for clip_idx in 0..clip_count {
            // ── Geometry ─────────────────────────────────────────────────────
            let (start_frame, end_frame) = {
                let clip = &engine.track.object_tracks[track_idx].clips[clip_idx];
                (clip.start_frame, clip.end_frame)
            };

            let start_x =
                rect.left() + self.sidebar_width + self.pan_x + start_frame as f32 * self.zoom_x;
            let end_x =
                rect.left() + self.sidebar_width + self.pan_x + end_frame as f32 * self.zoom_x;

            // Culling
            if end_x < rect.left() + self.sidebar_width || start_x > rect.right() {
                continue;
            }

            let clamped_start = start_x.max(rect.left() + self.sidebar_width);
            let clamped_end = end_x.min(rect.right());
            let clip_rect = Rect::from_min_max(
                Pos2::new(clamped_start, rect.top() + 3.0),
                Pos2::new(clamped_end, rect.bottom() - 3.0),
            );

            let is_active =
                engine.current_frame >= start_frame && engine.current_frame <= end_frame;
            let is_selected = *selected_clip == Some((track_idx, clip_idx));

            // ── Body fill ─────────────────────────────────────────────────────
            let fill = if is_active {
                Color32::from_rgb(0, 100, 200)
            } else {
                Color32::from_rgb(40, 60, 90)
            };
            painter.rect_filled(clip_rect, 2.0, fill);

            let stroke_col = if is_selected {
                Color32::WHITE
            } else {
                Color32::from_rgb(0, 150, 255)
            };
            painter.rect_stroke(
                clip_rect,
                2.0,
                Stroke::new(if is_selected { 2.0 } else { 1.0 }, stroke_col),
                eframe::egui::StrokeKind::Middle,
            );

            // Color identity strip at bottom
            let [r, g, b, _] = engine.track.object_tracks[track_idx].clips[clip_idx].color;
            painter.rect_filled(
                Rect::from_min_max(
                    Pos2::new(clip_rect.left(), clip_rect.bottom() - 2.0),
                    clip_rect.max,
                ),
                0.0,
                Color32::from_rgba_unmultiplied(r, g, b, 255),
            );

            // Clip label (inset past trim handles)
            let label = engine.track.object_tracks[track_idx].clips[clip_idx]
                .name
                .clone();
            painter.text(
                Pos2::new(clip_rect.left() + trim_w + 4.0, clip_rect.center().y),
                egui::Align2::LEFT_CENTER,
                &label,
                egui::FontId::proportional(10.0),
                Color32::WHITE,
            );

            // ── Trim handles (In / Out) ───────────────────────────────────────
            let in_rect = Rect::from_min_max(
                clip_rect.min,
                Pos2::new(clip_rect.left() + trim_w, clip_rect.bottom()),
            );
            let out_rect = Rect::from_min_max(
                Pos2::new(clip_rect.right() - trim_w, clip_rect.top()),
                clip_rect.max,
            );

            let in_id = ui.id().with("tin").with(track_idx).with(clip_idx);
            let out_id = ui.id().with("tout").with(track_idx).with(clip_idx);
            let in_resp = ui.interact(in_rect, in_id, egui::Sense::drag());
            let out_resp = ui.interact(out_rect, out_id, egui::Sense::drag());

            // Highlight on hover or active drag
            let in_dragging = self
                .trim_drag
                .map(|t| {
                    t.track_idx == track_idx && t.clip_idx == clip_idx && t.side == TrimSide::In
                })
                .unwrap_or(false);
            let out_dragging = self
                .trim_drag
                .map(|t| {
                    t.track_idx == track_idx && t.clip_idx == clip_idx && t.side == TrimSide::Out
                })
                .unwrap_or(false);

            if in_resp.hovered() || in_dragging {
                painter.rect_filled(
                    in_rect,
                    1.0,
                    Color32::from_rgba_premultiplied(255, 200, 0, 70),
                );
                ui.ctx().set_cursor_icon(egui::CursorIcon::ResizeHorizontal);
            }
            if out_resp.hovered() || out_dragging {
                painter.rect_filled(
                    out_rect,
                    1.0,
                    Color32::from_rgba_premultiplied(255, 200, 0, 70),
                );
                ui.ctx().set_cursor_icon(egui::CursorIcon::ResizeHorizontal);
            }

            // Start trim drag
            if in_resp.drag_started() {
                self.push_undo(engine);
                self.trim_drag = Some(TrimDrag {
                    track_idx,
                    clip_idx,
                    side: TrimSide::In,
                });
            }
            if out_resp.drag_started() {
                self.push_undo(engine);
                self.trim_drag = Some(TrimDrag {
                    track_idx,
                    clip_idx,
                    side: TrimSide::Out,
                });
            }

            // Apply active trim drag for this clip
            if let Some(td) = self.trim_drag {
                if td.track_idx == track_idx && td.clip_idx == clip_idx {
                    let delta_px = match td.side {
                        TrimSide::In => in_resp.drag_delta().x,
                        TrimSide::Out => out_resp.drag_delta().x,
                    };
                    let df = (delta_px / self.zoom_x).round() as i32;
                    if df != 0 {
                        let clip = &mut engine.track.object_tracks[track_idx].clips[clip_idx];
                        match td.side {
                            TrimSide::In => {
                                let new_s = (clip.start_frame as i32 + df).max(0) as u32;
                                if new_s < clip.end_frame {
                                    clip.start_frame = new_s;
                                }
                            }
                            TrimSide::Out => {
                                let new_e = (clip.end_frame as i32 + df)
                                    .max(clip.start_frame as i32 + 1)
                                    as u32;
                                clip.end_frame = new_e;
                            }
                        }
                    }
                    if ui.input(|i| i.pointer.any_released()) {
                        self.trim_drag = None;
                    }
                }
            }

            // ── Body interaction (move / click) ───────────────────────────────
            let body_rect = Rect::from_min_max(
                Pos2::new(clip_rect.left() + trim_w, clip_rect.top()),
                Pos2::new(clip_rect.right() - trim_w, clip_rect.bottom()),
            );
            let body_id = ui.id().with("cbody").with(track_idx).with(clip_idx);
            let body = ui.interact(body_rect, body_id, egui::Sense::click_and_drag());

            if body.clicked() {
                *selected_clip = Some((track_idx, clip_idx));
                action_loc = Some(
                    engine.track.object_tracks[track_idx].clips[clip_idx]
                        .location
                        .clone(),
                );
            }

            if body.dragged() {
                *selected_clip = Some((track_idx, clip_idx));
                let df = (body.drag_delta().x / self.zoom_x).round() as i32;
                if df != 0 {
                    let (cur_start, dur) = {
                        let c = &engine.track.object_tracks[track_idx].clips[clip_idx];
                        (c.start_frame, c.end_frame - c.start_frame)
                    };
                    let raw_new = (cur_start as i32 + df).max(0) as u32;
                    // Snap while dragging
                    let snapped = self.snap_frame(raw_new, engine, Some((track_idx, clip_idx)));
                    let c = &mut engine.track.object_tracks[track_idx].clips[clip_idx];
                    c.start_frame = snapped;
                    c.end_frame = snapped + dur;
                }
            }

            // ── Context menu (right-click on clip) ────────────────────────────
            let ctx_id = ui.id().with("cctx").with(track_idx).with(clip_idx);
            ui.interact(clip_rect, ctx_id, egui::Sense::hover())
                .context_menu(|ui| {
                    ui.set_min_width(180.0);

                    if ui.button("Select").clicked() {
                        *selected_clip = Some((track_idx, clip_idx));
                        ui.close_menu();
                    }
                    ui.separator();

                    if ui.button("⊢  Trim In to Playhead").clicked() {
                        *deferred = Some(ContextAction::TrimInToPlayhead(track_idx, clip_idx));
                        ui.close_menu();
                    }
                    if ui.button("⊣  Trim Out to Playhead").clicked() {
                        *deferred = Some(ContextAction::TrimOutToPlayhead(track_idx, clip_idx));
                        ui.close_menu();
                    }
                    ui.separator();

                    if ui.button("🗑  Delete").clicked() {
                        *deferred = Some(ContextAction::Delete(track_idx, clip_idx));
                        ui.close_menu();
                    }
                    if ui.button("✂  Ripple Delete").clicked() {
                        *deferred = Some(ContextAction::RippleDelete(track_idx, clip_idx));
                        ui.close_menu();
                    }
                    ui.separator();

                    if ui.button("🏳  Add Marker Here").clicked() {
                        *deferred = Some(ContextAction::AddMarkerHere(engine.current_frame));
                        ui.close_menu();
                    }
                });
        }

        action_loc
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Playhead
    // ─────────────────────────────────────────────────────────────────────────

    fn draw_playhead(
        &self,
        painter: &Painter,
        timeline_rect: Rect,
        ruler_rect: Rect,
        engine: &MapEngine,
    ) {
        let x = timeline_rect.left() + self.pan_x + engine.current_frame as f32 * self.zoom_x;
        if x < timeline_rect.left() || x > timeline_rect.right() {
            return;
        }
        // Vertical line
        painter.line_segment(
            [
                Pos2::new(x, ruler_rect.top()),
                Pos2::new(x, timeline_rect.bottom()),
            ],
            Stroke::new(2.0, Color32::from_rgb(0, 150, 255)),
        );
        // Downward-pointing triangle cap
        painter.add(egui::Shape::convex_polygon(
            vec![
                Pos2::new(x - 5.0, ruler_rect.top() + 2.0),
                Pos2::new(x + 5.0, ruler_rect.top() + 2.0),
                Pos2::new(x, ruler_rect.top() + 11.0),
            ],
            Color32::from_rgb(0, 150, 255),
            Stroke::NONE,
        ));
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Snap indicator (faint yellow line at snapped position while dragging)
    // ─────────────────────────────────────────────────────────────────────────

    fn draw_snap_indicator(&self, painter: &Painter, timeline_rect: Rect, engine: &MapEngine) {
        if !self.snap.enabled {
            return;
        }
        // Only draw while a clip body or trim drag is active
        let dragging = self.trim_drag.is_some() || painter.ctx().is_being_dragged(egui::Id::NULL); // rough proxy

        if !dragging {
            return;
        }

        // Show snap points as faint tick marks on the timeline
        let snaps: Vec<u32> = {
            let mut v = Vec::new();
            if self.snap.to_playhead {
                v.push(engine.current_frame);
            }
            for m in &self.markers {
                v.push(m.frame);
            }
            v
        };

        for frame in snaps {
            let x = timeline_rect.left() + self.pan_x + frame as f32 * self.zoom_x;
            if x < timeline_rect.left() || x > timeline_rect.right() {
                continue;
            }
            painter.line_segment(
                [
                    Pos2::new(x, timeline_rect.top()),
                    Pos2::new(x, timeline_rect.bottom()),
                ],
                Stroke::new(1.0, Color32::from_rgba_premultiplied(255, 220, 50, 35)),
            );
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Input Handling
    // ─────────────────────────────────────────────────────────────────────────

    fn handle_input(
        &mut self,
        ui: &mut egui::Ui,
        response: egui::Response,
        timeline_rect: Rect,
        ruler_rect: Rect,
        engine: &mut MapEngine,
        selected_clip: &mut Option<(usize, usize)>,
    ) {
        let hovering = ui.rect_contains_pointer(timeline_rect);

        // ── Keyboard shortcuts ────────────────────────────────────────────────
        if hovering || response.has_focus() {
            // Frame-by-frame stepping
            if ui.input(|i| i.key_pressed(egui::Key::ArrowRight) && !i.modifiers.any()) {
                engine.current_frame = (engine.current_frame + 1).min(1800);
            }
            if ui.input(|i| i.key_pressed(egui::Key::ArrowLeft) && !i.modifiers.any()) {
                engine.current_frame = engine.current_frame.saturating_sub(1);
            }
            // Jump to edit points (Shift + Arrow)
            if ui.input(|i| i.key_pressed(egui::Key::ArrowRight) && i.modifiers.shift) {
                self.jump_to_next_edit_point(engine);
            }
            if ui.input(|i| i.key_pressed(egui::Key::ArrowLeft) && i.modifiers.shift) {
                self.jump_to_prev_edit_point(engine);
            }
            // Home → go to frame 0
            if ui.input(|i| i.key_pressed(egui::Key::Home)) {
                engine.current_frame = 0;
            }
            // Space → play / pause
            if ui.input(|i| i.key_pressed(egui::Key::Space)) {
                engine.is_playing = !engine.is_playing;
            }
            // M → add marker
            if ui.input(|i| i.key_pressed(egui::Key::M) && !i.modifiers.any()) {
                self.add_marker(engine.current_frame);
            }
            // S → toggle snap
            if ui.input(|i| i.key_pressed(egui::Key::S) && !i.modifiers.any()) {
                self.snap.enabled = !self.snap.enabled;
            }
            // Delete → ripple-delete selected clip
            if ui.input(|i| i.key_pressed(egui::Key::Delete)) {
                if let Some((ti, ci)) = *selected_clip {
                    self.ripple_delete(engine, ti, ci);
                    *selected_clip = None;
                }
            }
            // Ctrl+Z / Ctrl+Y
            if ui.input(|i| i.key_pressed(egui::Key::Z) && i.modifiers.command) {
                self.undo(engine);
            }
            if ui.input(|i| i.key_pressed(egui::Key::Y) && i.modifiers.command) {
                self.redo(engine);
            }
        }

        // ── Ruler scrubbing ───────────────────────────────────────────────────
        if ui.rect_contains_pointer(ruler_rect) && ui.input(|i| i.pointer.primary_down()) {
            if let Some(pos) = ui.input(|i| i.pointer.hover_pos()) {
                let raw_frame =
                    ((pos.x - timeline_rect.left() - self.pan_x) / self.zoom_x).max(0.0) as u32;
                engine.current_frame = raw_frame.min(1800);
            }
        }

        // ── Right-click on ruler → marker menu ────────────────────────────────
        if ui.rect_contains_pointer(ruler_rect) {
            response.context_menu(|ui| {
                let hovered_frame = ui
                    .input(|i| i.pointer.hover_pos())
                    .map(|p| {
                        ((p.x - timeline_rect.left() - self.pan_x) / self.zoom_x).max(0.0) as u32
                    })
                    .unwrap_or(engine.current_frame);

                if ui.button("🏳  Add Marker Here").clicked() {
                    self.add_marker(hovered_frame);
                    ui.close_menu();
                }
                // Offer to delete nearby markers
                let nearby: Vec<u32> = self
                    .markers
                    .iter()
                    .filter(|m| (m.frame as i32 - hovered_frame as i32).abs() < 5)
                    .map(|m| m.frame)
                    .collect();
                for f in nearby {
                    if ui.button(format!("🗑  Remove Marker @ {}", f)).clicked() {
                        self.remove_marker(f);
                        ui.close_menu();
                    }
                }
            });
        }

        // ── Middle-mouse pan ──────────────────────────────────────────────────
        if response.dragged_by(egui::PointerButton::Middle) {
            self.pan_x += response.drag_delta().x;
        }

        // ── Horizontal scroll (no modifier) ──────────────────────────────────
        if hovering {
            let scroll = ui.input(|i| i.smooth_scroll_delta);
            if !ui.input(|i| i.modifiers.command) {
                // Horizontal scroll pans the timeline
                self.pan_x += scroll.x + scroll.y * 2.0;
            } else {
                // Ctrl + scroll → zoom around pointer
                let zoom_delta = scroll.y;
                if zoom_delta != 0.0 {
                    let last_zoom = self.zoom_x;
                    self.zoom_x = (self.zoom_x * 1.1_f32.powf(zoom_delta / 10.0)).clamp(0.1, 100.0);
                    if let Some(pos) = ui.input(|i| i.pointer.hover_pos()) {
                        let rel = pos.x - timeline_rect.left() - self.pan_x;
                        self.pan_x -= rel * (self.zoom_x / last_zoom - 1.0);
                    }
                }
            }
        }

        // Keep pan_x from going so far right that frame 0 disappears off-screen
        self.pan_x = self.pan_x.min(20.0);
    }
}
