import { useState } from "react";
import MapEditor from "./components/MapEditor";
import ProjectSetup from "./components/ProjectSetup";
import type { ProjectSettings, TimelineElement } from "./types";

function App() {
  const [project, setProject] = useState<ProjectSettings | null>(null);
  const [timelineElements, setTimelineElements] = useState<TimelineElement[]>([]);

  const handleLoadProject = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        if (data.project && Array.isArray(data.timelineElements)) {
          // Basic validation and potentially migration logic could go here
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

  return (
    <div key={project.width + project.height + project.fps + project.durationFrames}>
      <MapEditor 
        project={project} 
        setProject={setProject}
        timelineElements={timelineElements}
        setTimelineElements={setTimelineElements}
        onImport={handleLoadProject}
      />
    </div>
  );
}

export default App;
