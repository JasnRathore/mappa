# Project Manager Documentation

## Overview

The Project Manager is a new feature in Mappar that provides a user-friendly interface for managing and organizing your animation projects. When you launch the application, you'll be greeted with the Project Manager window instead of immediately opening the editor.

## Features

### 1. **Project Organization**
- Create, open, and manage multiple projects
- Projects are stored in a `./projects` directory
- Each project is saved as a separate folder

### 2. **Visual Project Cards**
- Each project is displayed as a card with a preview thumbnail
- Cards show the project name and other metadata
- Visual selection highlighting when hovering or selecting a project
- DaVinci Resolve-inspired design with three-circle icon

### 3. **Tab Navigation**
The Project Manager includes three tabs for different project sources:
- **Local**: Projects stored on your computer
- **Network**: Projects accessible from network sources (placeholder)
- **Cloud**: Projects stored in cloud services (placeholder)

### 4. **Project Management Options**
- **New Project**: Create a new project with a custom name
- **Open**: Open an existing project (switches to editor)
- **Export**: Export projects for sharing (placeholder)
- **Import**: Import projects from external sources (placeholder)

## Application Flow

```
┌─────────────────┐
│   App Launch    │
└────────┬────────┘
         │
         ▼
┌──────────────────────────┐
│  Project Manager Window  │
│  - Browse projects       │
│  - Create new project    │
│  - Open existing project │
└────────┬─────────────────┘
         │
         ├─► Create New ──┐
         │                 │
         │         ┌───────▼──────────┐
         │         │ New Project      │
         │         │ Dialog           │
         │         └────────┬─────────┘
         │                  │
         │         ┌────────▼──────────┐
         │         │ Project Created   │
         │         │ & Opened          │
         │         └────────┬─────────┘
         │                  │
         └─► Open Existing ─┤
         │                  │
         └──────────────────┼──────┐
                            │      │
                    ┌───────▼──────▼─┐
                    │  Editor Window │
                    │  (Animation    │
                    │   Timeline &   │
                    │   Map)         │
                    └────────────────┘
```

## Usage Guide

### Starting the Application

When you launch Mappar, the Project Manager window opens automatically. This replaces the previous behavior of directly opening the editor.

### Creating a New Project

1. Click the **"➕ New Project"** button in the bottom-right corner
2. Enter a project name in the dialog box
3. Click **"Create"** to create the project
4. The application will automatically close the Project Manager and open the editor with the new project

### Opening an Existing Project

1. **Method 1**: Double-click on a project card
2. **Method 2**: Click to select a project card, then click **"▶ Open"** button
3. The Project Manager closes and the editor opens with your selected project

### Returning to Project Manager from Editor

While in the editor, you can return to the Project Manager by:
- Using the **File → Back to Projects** menu option

This closes the current editor session and returns you to the Project Manager without saving. (Save your work first!)

## Architecture

### Files and Modules

#### `src/project_manager.rs`
The main module containing:

**Structures:**
- `Project`: Represents a single project with name, path, and last modified date
- `ProjectManager`: Manages all projects and project operations
- `ProjectAction`: Enum for different actions (Open, NewProject)
- `ProjectTab`: Enum for different tabs (Local, Network, Cloud)

**Key Methods:**
- `new()`: Initialize the ProjectManager and load existing projects
- `load_projects()`: Scan the projects directory and load all projects
- `create_project(name)`: Create a new project folder
- `open_project(index)`: Get the path to an existing project
- `delete_project(index)`: Remove a project (not exposed in UI yet)
- `ui()`: Render the project manager UI

#### `src/main.rs` (Modified)

**New Structures:**
- `AppState`: Enum to track whether we're in ProjectManager or Editor state
- `EditorState`: Contains all the previous `MyApp` fields, now nested
- `MyApp`: Now contains editor state, project manager, and app state

**New Methods:**
- `ui_project_manager()`: Renders the project manager UI
- `ui_editor()`: Renders the editor UI (refactored from original ui())

**State Management:**
- Apps alternate between ProjectManager and Editor states
- Editor is created once and persists until user returns to project manager

### Data Structure

Projects are stored in the following structure:
```
./projects/
├── Project Name 1/
│   └── (project files)
├── Project Name 2/
│   └── (project files)
└── Project Name 3/
    └── (project files)
```

## UI Components

### Project Card Design
- **Size**: 220×160 pixels
- **Background**: Dark gray with hover and selection states
- **Icon**: Three orange circles (DaVinci Resolve style)
- **Name**: Project title displayed below thumbnail
- **Selection**: Orange border when selected

### Color Scheme
- **Default Background**: `egui::Color32::from_gray(50)`
- **Hover Background**: `egui::Color32::from_gray(70)`
- **Selected Background**: `egui::Color32::from_rgb(220, 100, 20)`
- **Selected Border**: `egui::Color32::from_rgb(255, 165, 0)` (orange)
- **Icon Color**: Changes to orange when selected

## Future Enhancements

### Planned Features
1. **Project Deletion**: Add delete button to project cards
2. **Project Properties**: Edit project details (name, description)
3. **Recent Projects**: Quick access to recently opened projects
4. **Project Templates**: Start new projects from templates
5. **Cloud Integration**: Full implementation of Cloud tab
6. **Network Projects**: Full implementation of Network tab
7. **Import/Export**: Functional project export and import
8. **Thumbnails**: Generate and display actual project thumbnails
9. **Project Search**: Search through projects by name or metadata
10. **Favorites**: Mark projects as favorites for quick access

### Backend Improvements
1. Async project operations (create/delete without blocking UI)
2. Project metadata storage (thumbnails, descriptions, tags)
3. Project versioning and backup system
4. Project synchronization with cloud services

## API Reference

### ProjectManager

```rust
impl ProjectManager {
    pub fn new() -> Self
    pub fn load_projects(&mut self)
    pub fn create_project(&mut self, name: &str) -> Result<PathBuf, String>
    pub fn open_project(&self, index: usize) -> Result<PathBuf, String>
    pub fn delete_project(&mut self, index: usize) -> Result<(), String>
    pub fn ui(&mut self, ui: &mut egui::Ui) -> Option<ProjectAction>
}
```

### ProjectAction

```rust
pub enum ProjectAction {
    Open(usize),      // Open project at index
    NewProject,       // Create new project
}
```

## Troubleshooting

### Projects Not Showing

If projects aren't appearing in the Project Manager:
1. Verify the `./projects` directory exists
2. Check that projects are in subdirectories (not as files)
3. Restart the application

### Project Won't Open

If a project fails to open:
1. Ensure the project folder isn't corrupted
2. Check file permissions on the project directory
3. Try creating a new project to verify the system works

### Going Back to Projects Doesn't Work

The "Back to Projects" option closes the current editor state. Make sure to save your work before using this option, as changes may be lost.

## Configuration

### Project Directory

The default projects directory is `./projects` relative to the executable. To change this, modify the `ProjectManager::new()` method in `src/project_manager.rs`:

```rust
pub fn new() -> Self {
    let projects_dir = PathBuf::from("./projects"); // ← Change this path
    // ...
}
```

## Performance Considerations

- Projects are loaded into memory on application startup
- Large numbers of projects (100+) may cause UI slowdown
- Project list is reloaded each time you return to the Project Manager

For optimization with many projects, consider implementing:
- Lazy loading of project metadata
- Pagination of project cards
- Search/filtering functionality