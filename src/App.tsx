import { useEffect } from "react";
import ProjectSetup from "./components/ProjectSetup";
import MapRenderer from "./components/MapRenderer";
import { Workspace } from "./components/layout/Workspace";
import { useProjectStore } from "./store/useProjectStore";

function App() {
  const searchParams = new URLSearchParams(window.location.search);
  const mode = searchParams.get("mode");
  const projectPath = searchParams.get("projectPath");
  const { project, loadProject } = useProjectStore();

  useEffect(() => {
    if (mode === "editor" && projectPath && !project) {
      console.log("[Mappa] App: Multi-window editor mode detected. Loading project:", projectPath);
      loadProject(projectPath);
    }
  }, [mode, projectPath, loadProject, project]);

  // View Routing
  if (mode === "render") {
    return <MapRenderer />;
  }

  // If explicitly in editor mode OR we have a project loaded in this window
  if (mode === "editor" || project) {
    return <Workspace />;
  }

  // Default fallback: Project Manager
  return (
    <ProjectSetup 
      onComplete={() => {}} 
      onImport={() => {}} 
    />
  );
}

export default App;
