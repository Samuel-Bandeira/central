import type { Activity, Project } from '../types';
import { ActivitiesPanel } from '../components/ActivitiesPanel';

interface Props {
  project: Project | null;
  allProjects: Project[];
  onOpenGraph: (activity: Activity) => void;
}

export function ActivitiesTab({ project, allProjects, onOpenGraph }: Props) {
  if (!project) {
    return <p className="pending-note">Este projeto foi removido.</p>;
  }

  return (
    <div className="detail-tab">
      <div className="detail-header">
        <h1>{project.name}</h1>
      </div>
      <ActivitiesPanel
        projectId={project.id}
        hasFolders={project.folders.length > 0}
        projects={allProjects}
        onOpenGraph={onOpenGraph}
      />
    </div>
  );
}
