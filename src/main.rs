use eframe::egui::{CentralPanel, Panel};
use eframe::{self, egui};

mod engine;
use engine::MapEngine;

fn main() -> Result<(), eframe::Error> {
    let options = eframe::NativeOptions::default();

    eframe::run_native(
        "Mappar",
        options,
        Box::new(|_cc| Ok(Box::new(MyApp::default()))),
    )
}

struct MyApp {
    map: MapEngine,
}

impl Default for MyApp {
    fn default() -> Self {
        Self {
            map: MapEngine::new(),
        }
    }
}

// ⚠️ YOUR VERSION EXPECTS `ui`, NOT `update`
impl eframe::App for MyApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        app_ui(&ctx, ui, &mut self.map);
    }
}

fn app_ui(ctx: &egui::Context, root_ui: &mut egui::Ui, map: &mut MapEngine) {
    Panel::bottom("timeline")
        .resizable(true)
        .default_size(600.0)
        .min_size(200.0)
        .show(ctx, |ui| {
            ui.centered_and_justified(|ui| {
                ui.heading("TIMELINE");
            });
        });

    Panel::left("media_pool")
        .resizable(true)
        .default_size(180.0)
        .show(ctx, |ui| {
            ui.centered_and_justified(|ui| {
                ui.heading("MEDIA");
            });
        });

    Panel::right("inspector")
        .resizable(true)
        .default_size(220.0)
        .show(ctx, |ui| {
            ui.centered_and_justified(|ui| {
                ui.heading("INSPECTOR");
            });
        });

    CentralPanel::default().show(ctx, |ui| {
        ui.vertical(|ui| {
            ui.label(format!("Zoom: {}", map.zoom));
            ui.separator();

            egui::Frame::new()
                .fill(egui::Color32::from_gray(15))
                .inner_margin(egui::Margin::same(4))
                .show(ui, |ui| {
                    map.ui(ui, ctx);
                });
        });
    });
}
