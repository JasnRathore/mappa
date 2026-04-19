use eframe::egui::{self, Color32, CornerRadius, Stroke, Visuals};

// ── Brand ─────────────────────────────────────────────────────────────────────
// Keep your primary red; everything else adopts DaVinci's neutral palette.
pub const PRIMARY: Color32 = Color32::from_rgb(181, 53, 42);
pub const PRIMARY_FG: Color32 = Color32::from_rgb(248, 240, 239);
pub const DESTRUCTIVE: Color32 = Color32::from_rgb(232, 92, 58);

// ── DaVinci-style neutral palette ────────────────────────────────────────────
// Backgrounds (darkest → lightest)
pub const BG_BASE: Color32 = Color32::from_rgb(18, 18, 18); // root / extreme bg
pub const BG_PANEL: Color32 = Color32::from_rgb(28, 28, 28); // panels
pub const BG_RAISED: Color32 = Color32::from_rgb(38, 38, 38); // toolbar strips, headers
pub const BG_INPUT: Color32 = Color32::from_rgb(22, 22, 22); // text inputs / drag values
pub const BG_HOVER: Color32 = Color32::from_rgb(48, 48, 48); // hover state
pub const BG_ACTIVE: Color32 = Color32::from_rgb(58, 58, 58); // pressed / active (neutral)

// Borders
pub const BORDER: Color32 = Color32::from_rgb(52, 52, 52); // standard separator
pub const BORDER_SUBTLE: Color32 = Color32::from_rgb(36, 36, 36); // inner panel dividers
pub const BORDER_FOCUS: Color32 = Color32::from_rgb(80, 80, 80); // hovered border

// Text
pub const TEXT: Color32 = Color32::from_rgb(204, 204, 204); // main text
pub const TEXT_MUTED: Color32 = Color32::from_rgb(120, 120, 120); // labels, hints
pub const TEXT_DIM: Color32 = Color32::from_rgb(72, 72, 72); // disabled / very muted

// Selection — red at ~40% opacity, pre-multiplied: 181*100/255=71, 53*100/255=21, 42*100/255=16
pub const SELECTION: Color32 = Color32::from_rgba_premultiplied(71, 21, 16, 100);

// ── Radius ────────────────────────────────────────────────────────────────────
// DaVinci uses essentially square corners everywhere. 2px max.
const R_NONE: u8 = 0;
const R_SM: u8 = 2;
const R_MD: u8 = 2;

pub fn apply(ctx: &egui::Context) {
    // Embed visuals into style before the single set_global_style call,
    // otherwise set_global_style overwrites visuals with its defaults.
    let mut s = style();
    s.visuals = visuals();
    ctx.set_global_style(s);
}

fn visuals() -> Visuals {
    let mut v = Visuals::dark();

    // ── Backgrounds ──────────────────────────────────────────────────────────
    v.panel_fill = BG_PANEL;
    v.window_fill = BG_PANEL;
    v.faint_bg_color = BG_RAISED;
    v.extreme_bg_color = BG_BASE;

    // ── Window chrome ────────────────────────────────────────────────────────
    v.window_stroke = Stroke::new(1.0, BORDER);
    v.window_corner_radius = CornerRadius::same(R_NONE); // sharp — DaVinci has no rounded windows
    v.window_shadow = egui::Shadow::NONE;

    // ── Widgets: noninteractive (separators, static labels) ──────────────────
    v.widgets.noninteractive.bg_fill = BG_RAISED;
    v.widgets.noninteractive.weak_bg_fill = BG_PANEL;
    v.widgets.noninteractive.bg_stroke = Stroke::new(1.0, BORDER_SUBTLE);
    v.widgets.noninteractive.fg_stroke = Stroke::new(1.0, TEXT_MUTED);
    v.widgets.noninteractive.corner_radius = CornerRadius::same(R_NONE);

    // ── Widgets: inactive (buttons, inputs at rest) ───────────────────────────
    v.widgets.inactive.bg_fill = BG_RAISED;
    v.widgets.inactive.weak_bg_fill = BG_INPUT;
    v.widgets.inactive.bg_stroke = Stroke::new(1.0, BORDER);
    v.widgets.inactive.fg_stroke = Stroke::new(1.0, TEXT);
    v.widgets.inactive.corner_radius = CornerRadius::same(R_SM);

    // ── Widgets: hovered ──────────────────────────────────────────────────────
    v.widgets.hovered.bg_fill = BG_HOVER;
    v.widgets.hovered.weak_bg_fill = BG_HOVER;
    v.widgets.hovered.bg_stroke = Stroke::new(1.0, BORDER_FOCUS);
    v.widgets.hovered.fg_stroke = Stroke::new(1.0, TEXT);
    v.widgets.hovered.corner_radius = CornerRadius::same(R_SM);

    // ── Widgets: active/pressed ───────────────────────────────────────────────
    // Neutral press for most widgets (buttons, sliders)…
    v.widgets.active.bg_fill = BG_ACTIVE;
    v.widgets.active.weak_bg_fill = BG_ACTIVE;
    v.widgets.active.bg_stroke = Stroke::new(1.0, PRIMARY); // red accent on press
    v.widgets.active.fg_stroke = Stroke::new(1.0, TEXT);
    v.widgets.active.corner_radius = CornerRadius::same(R_SM);

    // ── Widgets: open (dropdowns, combo boxes) ────────────────────────────────
    v.widgets.open.bg_fill = BG_RAISED;
    v.widgets.open.weak_bg_fill = BG_RAISED;
    v.widgets.open.bg_stroke = Stroke::new(1.0, BORDER_FOCUS);
    v.widgets.open.fg_stroke = Stroke::new(1.0, TEXT);
    v.widgets.open.corner_radius = CornerRadius::same(R_SM);

    // ── Selection (selectable_value highlight, text selection) ───────────────
    v.selection.bg_fill = SELECTION;
    v.selection.stroke = Stroke::new(1.0, PRIMARY);

    // ── Override text color globally ─────────────────────────────────────────
    // DaVinci uses ~#ccc, not pure white
    v.override_text_color = Some(TEXT);

    // ── Misc ─────────────────────────────────────────────────────────────────
    v.hyperlink_color = PRIMARY;
    v.warn_fg_color = DESTRUCTIVE;
    v.error_fg_color = DESTRUCTIVE;
    v.popup_shadow = egui::Shadow::NONE;

    v.text_cursor = egui::style::TextCursorStyle {
        stroke: Stroke::new(2.0, PRIMARY),
        ..Default::default()
    };

    v
}

fn style() -> egui::Style {
    let mut s = egui::Style::default();

    // DaVinci is very dense — tight spacing throughout
    s.spacing.item_spacing = egui::vec2(4.0, 3.0);
    s.spacing.button_padding = egui::vec2(8.0, 3.0);
    s.spacing.indent = 14.0;
    s.spacing.slider_width = 100.0;
    s.spacing.combo_width = 100.0;

    // Sharp margins
    s.spacing.menu_margin = egui::Margin::same(4);
    s.spacing.window_margin = egui::Margin::same(8);

    // Thin scrollbar matching DaVinci's minimal scroll indicators
    s.spacing.scroll = egui::style::ScrollStyle {
        bar_width: 6.0,
        handle_min_length: 20.0,
        bar_inner_margin: 1.0,
        bar_outer_margin: 0.0,
        ..Default::default()
    };

    // Slightly smaller text overall — DaVinci is a dense pro tool
    s.text_styles = {
        use egui::{FontFamily::Proportional, FontId, TextStyle::*};
        [
            (Small, FontId::new(10.0, Proportional)),
            (Body, FontId::new(12.0, Proportional)),
            (Button, FontId::new(12.0, Proportional)),
            (Heading, FontId::new(13.0, Proportional)),
            (Monospace, FontId::new(11.0, egui::FontFamily::Monospace)),
        ]
        .into()
    };

    s
}

// ── Helper: section header matching DaVinci's "• Transform" style ────────────
/// Draws a colored dot + label as a collapsible section header.
/// Use in place of ui.heading() for inspector sections.
///
/// ```rust
/// theme::section_header(ui, PRIMARY, "Transform");
/// ```
pub fn section_header(ui: &mut egui::Ui, dot_color: Color32, label: &str) {
    ui.horizontal(|ui| {
        let dot_rect = ui
            .allocate_exact_size(egui::vec2(8.0, 8.0), egui::Sense::hover())
            .0;
        ui.painter()
            .circle_filled(dot_rect.center(), 3.5, dot_color);
        ui.add_space(4.0);
        ui.label(egui::RichText::new(label).size(12.0).color(TEXT));
    });
}
