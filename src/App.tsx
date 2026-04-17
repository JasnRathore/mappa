import ProjectSetup from "./components/ProjectSetup";
import MapRenderer from "./components/MapRenderer";
import { Workspace } from "./components/layout/Workspace";
import { useProjectStore } from "./store/useProjectStore";

function App() {
  const isRenderMode = window.location.search.includes("mode=render");
  const { project, setProject } = useProjectStore();

  if (isRenderMode) {
    return <MapRenderer />;
  }

  if (!project) {
    return (
      <ProjectSetup 
        onComplete={(settings) => setProject(settings)} 
        onImport={() => {}} // Redundant now as managed by store
      />
    );
  }

  return <Workspace />;
}

export default App;
