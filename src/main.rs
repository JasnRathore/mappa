use eframe::egui::{CentralPanel, Panel};
use eframe::{self, egui};

mod engine;
use engine::MapEngine;

fn main() -> Result<(), eframe::Error> {
    let options = eframe::NativeOptions::default();

    eframe::run_native(
        "Mappar",
        options,
        Box::new(|cc| Ok(Box::new(MyApp::new(cc)))),
    )
}

struct MyApp {
    map: MapEngine,
}

impl MyApp {
    fn new(cc: &eframe::CreationContext<'_>) -> Self {
        Self {
            map: MapEngine::new(cc),
        }
    }
}

impl eframe::App for MyApp {
    // The 'ui' method provides 'ui: &mut egui::Ui'
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        app_ui(ui, &mut self.map);
    }
}

fn app_ui(ui: &mut egui::Ui, map: &mut MapEngine) {
    // Fix: Pass the 'ui' reference into show_inside, not 'ctx'
    Panel::bottom("timeline")
        .resizable(true)
        .default_size(200.0)
        .show_inside(ui, |ui| {
            ui.centered_and_justified(|ui| {
                ui.heading("TIMELINE");
            });
        });

    Panel::left("media_pool")
        .resizable(true)
        .default_size(180.0)
        .show_inside(ui, |ui| {
            ui.centered_and_justified(|ui| {
                ui.heading("MEDIA");
            });
        });

    Panel::right("inspector")
        .resizable(true)
        .default_size(220.0)
        .show_inside(ui, |ui| {
            ui.centered_and_justified(|ui| {
                ui.heading("INSPECTOR");
            });
        });

    CentralPanel::default().show_inside(ui, |ui| {
        ui.vertical(|ui| {
            ui.label(format!("Zoom: {:.1}", map.zoom()));
            ui.separator();

            egui::Frame::new()
                .fill(egui::Color32::from_gray(15))
                .inner_margin(egui::Margin::same(0))
                .show(ui, |ui| {
                    map.ui(ui);
                });
        });
    });
}
