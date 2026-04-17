
import ProjectSetup from "./components/ProjectSetup";
import MapRenderer from "./components/MapRenderer";
import { Workspace } from "./components/layout/Workspace";
import { useProjectStore } from "./store/useProjectStore";

function App() {
  const isRenderMode = window.location.search.includes("mode=render");
  const { project, setProject, setTimelineElements } = useProjectStore();

  if (isRenderMode) {
    // Note: Render mode handles its own IndexedDB state parsing 
    // but ideally could also just use zustand if passed correctly.
    // Keeping existing behavior for render mode.
    return <MapRenderer />;
  }

  const handleLoadProject = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        if (data.project && Array.isArray(data.timelineElements)) {
          setProject(data.project);
          setTimelineElements(data.timelineElements);
        } else {
          alert("Invalid project file format.");
        }
      } catch (err) {
        console.error("Error parsing project file:", err);
        alert("Failed to read project file.");
      }
    };
    reader.readAsText(file);
  };

  if (!project) {
    return (
      <ProjectSetup 
        onComplete={setProject} 
        onImport={handleLoadProject}
      />
    );
  }

  return <Workspace />;
}

export default App;
