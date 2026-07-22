import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Activity, ActivityStep, Project } from '../types';
import { ActivityCard } from '../components/ActivityCard';

const RUNNING_POLL_INTERVAL_MS = 5000;
const PROGRESS_POLL_INTERVAL_MS = 4000;

interface Props {
  projectId: string;
  activityId: string;
  projects: Project[];
}

// Mesmo card usado na lista compacta (ver ActivityCard), só que sozinho
// numa aba dedicada — o CSS de `.activity-graph-tab` faz o diagrama ocupar
// o espaço vertical disponível em vez do card de 480px da lista, mas o
// resto (subtasks, critérios de aceite, editar, pausar...) continua igual.
export function ActivityGraphTab({ projectId, activityId, projects }: Props) {
  const [activity, setActivity] = useState<Activity | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [running, setRunning] = useState(false);
  const [needsAttention, setNeedsAttention] = useState(false);
  const [steps, setSteps] = useState<ActivityStep[]>([]);
  const [summary, setSummary] = useState('');

  const project = projects.find((p) => p.id === projectId) ?? null;
  const otherProjects = projects.filter((p) => p.id !== projectId);
  const projectsById = new Map(projects.map((p) => [p.id, p]));

  const refresh = useCallback(async () => {
    const list = await api.listActivities(projectId);
    const found = list.find((a) => a.id === activityId) ?? null;
    setActivity(found);
    setNotFound(!found);
  }, [projectId, activityId]);

  const refreshRunning = useCallback(async () => {
    const { activityIds, needsAttentionIds } = await api.getRunningActivities();
    setRunning(activityIds.includes(activityId));
    setNeedsAttention(needsAttentionIds.includes(activityId));
  }, [activityId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    refreshRunning();
    const interval = setInterval(refreshRunning, RUNNING_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refreshRunning]);

  useEffect(() => {
    if (!activity?.started) return;
    let cancelled = false;
    async function pollProgress() {
      try {
        const { steps, summary } = await api.getActivityProgress(activityId);
        if (!cancelled) {
          setSteps(steps);
          setSummary(summary);
        }
      } catch {
        // arquivo pode não existir ainda, ou estar no meio de uma escrita — ignora
      }
    }
    pollProgress();
    const interval = setInterval(pollProgress, PROGRESS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activity?.started, activityId]);

  if (notFound) {
    return <p className="pending-note">Esta atividade foi removida.</p>;
  }
  if (!activity || !project) {
    return <p className="pending-note">Carregando...</p>;
  }

  return (
    <div className="activity-graph-tab">
      <ul className="activity-list">
        <ActivityCard
          activity={activity}
          hasFolders={project.folders.length > 0}
          devBranch={project.devBranch}
          otherProjects={otherProjects}
          projectsById={projectsById}
          running={running}
          needsAttention={running && needsAttention}
          steps={steps}
          onStepsChange={setSteps}
          summary={summary}
          onChanged={refresh}
          onRefreshRunning={refreshRunning}
        />
      </ul>
    </div>
  );
}
