use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Project {
    pub name: String,
    pub path: PathBuf,
    pub last_modified: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ProjectAction {
    Open(usize),
    NewProject,
}

pub enum ProjectTab {
    Local,
    Network,
    Cloud,
}

pub struct ProjectManager {
    pub projects: Vec<Project>,
    pub projects_dir: PathBuf,
    pub selected_project: Option<usize>,
    pub current_tab: ProjectTab,
}

impl ProjectManager {
    pub fn new() -> Self {
        let projects_dir = PathBuf::from("./projects");
        let mut manager = ProjectManager {
            projects: Vec::new(),
            projects_dir,
            selected_project: None,
            current_tab: ProjectTab::Local,
        };
        manager.load_projects();
        manager
    }

    pub fn load_projects(&mut self) {
        if !self.projects_dir.exists() {
            let _ = fs::create_dir_all(&self.projects_dir);
        }

        self.projects.clear();
        if let Ok(entries) = fs::read_dir(&self.projects_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        let last_modified = entry
                            .metadata()
                            .and_then(|m| m.modified())
                            .map(|t| format!("{:?}", t))
                            .unwrap_or_default();

                        self.projects.push(Project {
                            name: name.to_string(),
                            path: path.clone(),
                            last_modified,
                        });
                    }
                }
            }
        }
    }

    pub fn create_project(&mut self, name: &str) -> Result<PathBuf, String> {
        let project_path = self.projects_dir.join(name);

        if project_path.exists() {
            return Err("Project already exists".to_string());
        }

        fs::create_dir_all(&project_path)
            .map_err(|e| format!("Failed to create project: {}", e))?;

        let project = Project {
            name: name.to_string(),
            path: project_path.clone(),
            last_modified: String::from("now"),
        };

        self.projects.push(project);
        Ok(project_path)
    }

    pub fn open_project(&self, index: usize) -> Result<PathBuf, String> {
        self.projects
            .get(index)
            .map(|p| p.path.clone())
            .ok_or_else(|| "Invalid project index".to_string())
    }

    pub fn delete_project(&mut self, index: usize) -> Result<(), String> {
        if index >= self.projects.len() {
            return Err("Invalid project index".to_string());
        }

        let project = &self.projects[index];
        fs::remove_dir_all(&project.path)
            .map_err(|e| format!("Failed to delete project: {}", e))?;

        self.projects.remove(index);
        Ok(())
    }

    pub fn ui(&mut self, ui: &mut egui::Ui) -> Option<ProjectAction> {
        let mut action = None;

        // Header
        ui.add_space(20.0);
        ui.heading(egui::RichText::new("Projects").size(32.0));
        ui.add_space(10.0);

        // Tab navigation + New Project button in header (right-aligned)
        ui.horizontal(|ui| {
            // Left: tabs
            ui.horizontal(|ui| {
                if ui
                    .selectable_label(matches!(self.current_tab, ProjectTab::Local), "Local")
                    .clicked()
                {
                    self.current_tab = ProjectTab::Local;
                }
                if ui
                    .selectable_label(matches!(self.current_tab, ProjectTab::Network), "Network")
                    .clicked()
                {
                    self.current_tab = ProjectTab::Network;
                }
                if ui
                    .selectable_label(matches!(self.current_tab, ProjectTab::Cloud), "Cloud")
                    .clicked()
                {
                    self.current_tab = ProjectTab::Cloud;
                }
            });

            // Right: New Project button
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.button("➕ New Project").clicked() {
                    action = Some(ProjectAction::NewProject);
                }
            });
        });

        ui.separator();
        ui.add_space(10.0);

        // Project grid
        egui::ScrollArea::vertical()
            .auto_shrink([false; 2])
            .show(ui, |ui| {
                if self.projects.is_empty() {
                    ui.vertical_centered(|ui| {
                        ui.add_space(40.0);
                        ui.heading("No projects yet");
                        ui.label("Create a new project to get started");
                    });
                } else {
                    ui.horizontal_wrapped(|ui| {
                        ui.spacing_mut().item_spacing = egui::vec2(20.0, 20.0);

                        for (idx, project) in self.projects.iter().enumerate() {
                            if self.draw_project_card(ui, project, idx) {
                                self.selected_project = Some(idx);
                                action = Some(ProjectAction::Open(idx));
                            }
                        }
                    });
                }
            });

        ui.add_space(20.0);
        ui.separator();
        ui.add_space(10.0);

        // Bottom button bar
        ui.horizontal(|ui| {
            if ui.button("📁 Export").clicked() {
                // TODO: Export project
            }
            if ui.button("📥 Import").clicked() {
                // TODO: Import project
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.button("➕ New Project").clicked() {
                    action = Some(ProjectAction::NewProject);
                }
                if ui.button("▶ Open").clicked() {
                    if let Some(idx) = self.selected_project {
                        action = Some(ProjectAction::Open(idx));
                    }
                }
            });
        });

        action
    }

    fn draw_project_card(&self, ui: &mut egui::Ui, project: &Project, idx: usize) -> bool {
        let is_selected = self.selected_project == Some(idx);
        let card_size = egui::vec2(220.0, 160.0);

        let (rect, response) = ui.allocate_exact_size(card_size, egui::Sense::click());

        // Background
        let bg_color = if is_selected {
            egui::Color32::from_rgb(220, 100, 20)
        } else if response.hovered() {
            egui::Color32::from_gray(70)
        } else {
            egui::Color32::from_gray(50)
        };

        ui.painter().rect_filled(rect, 12.0, bg_color);

        // Border for selected
        if is_selected {
            ui.painter().rect_stroke(
                rect,
                12.0,
                egui::Stroke {
                    width: 3.0,
                    color: egui::Color32::from_rgb(255, 165, 0),
                },
                egui::StrokeKind::Outside,
            );
        } else if response.hovered() {
            ui.painter().rect_stroke(
                rect,
                12.0,
                egui::Stroke {
                    width: 1.0,
                    color: egui::Color32::from_gray(120),
                },
                egui::StrokeKind::Outside,
            );
        }

        // Thumbnail area
        let thumbnail_rect = egui::Rect::from_min_size(rect.min, egui::vec2(220.0, 110.0));
        ui.painter()
            .rect_filled(thumbnail_rect, 8.0, egui::Color32::from_gray(25));

        // Icon (3 circles like DaVinci Resolve)
        let icon_center = thumbnail_rect.center();
        let circle_color = if is_selected {
            egui::Color32::from_rgb(255, 165, 0)
        } else {
            egui::Color32::from_gray(90)
        };

        ui.painter()
            .circle_filled(icon_center + egui::vec2(-14.0, 0.0), 10.0, circle_color);
        ui.painter().circle_filled(icon_center, 10.0, circle_color);
        ui.painter()
            .circle_filled(icon_center + egui::vec2(14.0, 0.0), 10.0, circle_color);

        // Project name
        let name_pos = rect.min + egui::vec2(12.0, 115.0);
        ui.painter().text(
            name_pos,
            egui::Align2::LEFT_TOP,
            &project.name,
            egui::FontId::proportional(14.0),
            egui::Color32::WHITE,
        );

        response.clicked()
    }
}
