use crate::animation;

pub mod timeline;

pub fn keyframe_button(
    ui: &mut egui::Ui,
    ch: &mut animation::Channel,
    current_frame: u32,
    value: animation::Value,
) -> (bool, bool) {
    let has_kf = ch.keyframes.iter().any(|k| k.frame == current_frame);

    let color = if has_kf {
        egui::Color32::from_rgb(255, 128, 0)
    } else {
        egui::Color32::GRAY
    };

    // get default button font size
    let base_font = ui.style().text_styles[&egui::TextStyle::Button].clone();

    let icon = if has_kf {
        let mut font_id = base_font.clone();
        font_id.family = egui::FontFamily::Name("phosphor_fill".into());

        egui::RichText::new(egui_phosphor::fill::DIAMOND).font(font_id)
    } else {
        egui::RichText::new(egui_phosphor::regular::DIAMOND)
    };

    let clicked = ui.button(icon.color(color)).clicked();

    if clicked {
        if has_kf {
            ch.keyframes.retain(|k| k.frame != current_frame);
        } else {
            ch.insert_keyframe(animation::Keyframe {
                frame: current_frame,
                value,
                interpolation: animation::Interpolation::Linear,
                flags: animation::KeyframeFlags::NONE,
            });
        }
        ch.dirty = true;
    }

    (clicked, has_kf)
}
