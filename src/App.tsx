import { useState } from "react";
import MapEditor from "./components/MapEditor";
import ProjectSetup from "./components/ProjectSetup";
import type { ProjectSettings } from "./types";

function App() {
  const [project, setProject] = useState<ProjectSettings | null>(null);

  if (!project) {
    return <ProjectSetup onComplete={setProject} />;
  }

  return (
    <>
      <MapEditor project={project} />
    </>
  );
}

export default App;
