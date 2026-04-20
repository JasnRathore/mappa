use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProjectSettings {
    pub name: String,
    pub resolution: [u32; 2],
    pub fps: f32,
}

impl Default for ProjectSettings {
    fn default() -> Self {
        Self {
            name: "New Project".to_string(),
            resolution: [1920, 1080],
            fps: 30.0,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Project {
    pub name: String,
    pub path: PathBuf,
    pub last_modified: String,
    pub settings: ProjectSettings,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ProjectAction {
    Open(usize),
    NewProject,
    Delete(usize),
    Rename(usize),
}

pub struct ProjectManager {
    pub projects: Vec<Project>,
    pub projects_dir: PathBuf,
    pub selected_project: Option<usize>,
}

impl ProjectManager {
    pub fn new() -> Self {
        let projects_dir = PathBuf::from("./projects");
        let mut manager = ProjectManager {
            projects: Vec::new(),
            projects_dir,
            selected_project: None,
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
                    let settings_path = path.join("project.json");
                    let settings = if settings_path.exists() {
                        fs::read_to_string(&settings_path)
                            .ok()
                            .and_then(|s| serde_json::from_str::<ProjectSettings>(&s).ok())
                            .unwrap_or_else(|| ProjectSettings {
                                name: path
                                    .file_name()
                                    .and_then(|n| n.to_str())
                                    .unwrap_or("Unknown")
                                    .to_string(),
                                ..Default::default()
                            })
                    } else {
                        ProjectSettings {
                            name: path
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("Unknown")
                                .to_string(),
                            ..Default::default()
                        }
                    };

                    let last_modified = entry
                        .metadata()
                        .and_then(|m| m.modified())
                        .map(|t| format!("{:?}", t))
                        .unwrap_or_default();

                    self.projects.push(Project {
                        name: settings.name.clone(),
                        path: path.clone(),
                        last_modified,
                        settings,
                    });
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

        let settings = ProjectSettings {
            name: name.to_string(),
            ..Default::default()
        };

        let settings_json = serde_json::to_string_pretty(&settings).unwrap();
        fs::write(project_path.join("project.json"), settings_json)
            .map_err(|e| format!("Failed to write project settings: {}", e))?;

        let project = Project {
            name: name.to_string(),
            path: project_path.clone(),
            last_modified: String::from("now"),
            settings,
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
        if project.path.exists() {
            fs::remove_dir_all(&project.path)
                .map_err(|e| format!("Failed to delete project: {}", e))?;
        }

        self.projects.remove(index);
        Ok(())
    }

    pub fn rename_project(&mut self, index: usize, new_name: String) -> Result<(), String> {
        if index >= self.projects.len() {
            return Err("Invalid project index".to_string());
        }

        let project = &mut self.projects[index];
        let old_path = project.path.clone();
        let new_path = old_path.parent().unwrap().join(&new_name);

        if new_path.exists() {
            return Err("A project with that name already exists".to_string());
        }

        // 1. Rename the directory
        fs::rename(&old_path, &new_path)
            .map_err(|e| format!("Failed to rename project directory: {}", e))?;

        // 2. Update project.json
        let mut settings = project.settings.clone();
        settings.name = new_name.clone();
        let settings_json = serde_json::to_string_pretty(&settings).unwrap();
        fs::write(new_path.join("project.json"), settings_json)
            .map_err(|e| format!("Failed to update project settings: {}", e))?;

        // 3. Update internal state
        project.name = new_name;
        project.path = new_path;
        project.settings = settings;

        Ok(())
    }

    pub fn ui(&mut self, ui: &mut egui::Ui) -> Option<ProjectAction> {
        let mut action = None;

        // Header
        ui.add_space(30.0);
        ui.horizontal(|ui| {
            ui.heading(
                egui::RichText::new("PROJECTS")
                    .size(20.0)
                    .strong()
                    .color(crate::theme::TEXT),
            );
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui
                    .button(egui::RichText::new("➕ NEW PROJECT").strong())
                    .clicked()
                {
                    action = Some(ProjectAction::NewProject);
                }
            });
        });
        ui.add_space(10.0);
        ui.separator();
        ui.add_space(20.0);

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
                            if let Some(card_action) = self.draw_project_card(ui, project, idx) {
                                match card_action {
                                    ProjectAction::Open(_) => {
                                        self.selected_project = Some(idx);
                                        action = Some(card_action);
                                    }
                                    _ => action = Some(card_action),
                                }
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
                if ui.button("🗑 Delete").clicked() {
                    if let Some(idx) = self.selected_project {
                        action = Some(ProjectAction::Delete(idx));
                    }
                }
            });
        });

        action
    }

    fn draw_project_card(
        &self,
        ui: &mut egui::Ui,
        project: &Project,
        idx: usize,
    ) -> Option<ProjectAction> {
        let is_selected = self.selected_project == Some(idx);
        let card_size = egui::vec2(220.0, 160.0);

        let (rect, response) = ui.allocate_exact_size(card_size, egui::Sense::click());

        // Background
        let bg_color = if is_selected {
            crate::theme::BG_HOVER
        } else if response.hovered() {
            crate::theme::BG_RAISED
        } else {
            crate::theme::BG_PANEL
        };

        ui.painter()
            .rect_filled(rect, egui::CornerRadius::ZERO, bg_color);

        // Border for selected
        if is_selected {
            ui.painter().rect_stroke(
                rect,
                0.0,
                egui::Stroke {
                    width: 2.0,
                    color: crate::theme::PRIMARY,
                },
                egui::StrokeKind::Outside,
            );
        } else if response.hovered() {
            ui.painter().rect_stroke(
                rect,
                0.0,
                egui::Stroke {
                    width: 1.0,
                    color: crate::theme::BORDER_FOCUS,
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
            egui::FontId::proportional(16.0),
            egui::Color32::WHITE,
        );

        // Subtitle (Res/FPS)
        let sub_pos = rect.min + egui::vec2(12.0, 137.0);
        let sub_text = format!(
            "{}x{} @ {}fps",
            project.settings.resolution[0], project.settings.resolution[1], project.settings.fps
        );
        ui.painter().text(
            sub_pos,
            egui::Align2::LEFT_TOP,
            sub_text,
            egui::FontId::proportional(11.0),
            egui::Color32::from_gray(160),
        );

        // Context menu
        let mut action = None;
        response.context_menu(|ui| {
            if ui.button("▶ Open").clicked() {
                action = Some(ProjectAction::Open(idx));
                ui.close_menu();
            }
            if ui.button("✏ Rename").clicked() {
                action = Some(ProjectAction::Rename(idx));
                ui.close_menu();
            }
            ui.separator();
            if ui.button("🗑 Delete").clicked() {
                action = Some(ProjectAction::Delete(idx));
                ui.close_menu();
            }
        });

        if action.is_some() {
            return action;
        }

        if response.clicked() {
            Some(ProjectAction::Open(idx))
        } else {
            None
        }
    }
}
