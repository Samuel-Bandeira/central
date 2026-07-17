import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { Project, Section } from '../types';
import { SectionBox } from '../components/SectionBox';
import { ProjectCard, type ProjectRunStatus } from '../components/ProjectCard';
import { NewProjectModal } from '../components/NewProjectModal';
import { ToastStack, type ToastItem } from '../components/ToastStack';

const RUNNING_POLL_INTERVAL_MS = 5000;
// Se o próximo polling não confirmar que parou dentro desse tempo, desiste
// do estado "desligando" e volta a confiar só no que o launchd reportar.
const STOPPING_TIMEOUT_MS = 20000;
const TOAST_DURATION_MS = 5000;
const CASCADE_OFFSET = 30;
const CASCADE_STEPS = 8;

interface Props {
  projects: Project[];
  sections: Section[];
  onProjectsChange: () => Promise<void>;
  onSectionsChange: () => Promise<void>;
  onOpenDetail: (project: Project) => void;
}

export function ProjectsTab({ projects, sections, onProjectsChange, onSectionsChange, onOpenDetail }: Props) {
  const [showNewProject, setShowNewProject] = useState(false);
  const [runningProjectIds, setRunningProjectIds] = useState<Set<string>>(new Set());
  const [stoppingProjectIds, setStoppingProjectIds] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const stoppingTimeouts = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  function showToast(message: string) {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, TOAST_DURATION_MS);
  }

  const refreshRunning = useCallback(async () => {
    const { projectIds } = await api.getRunningProjects();
    const runningSet = new Set(projectIds);
    setRunningProjectIds(runningSet);
    setStoppingProjectIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (runningSet.has(id)) {
          next.add(id);
        } else {
          const timeout = stoppingTimeouts.current.get(id);
          if (timeout) clearTimeout(timeout);
          stoppingTimeouts.current.delete(id);
        }
      });
      return next;
    });
  }, []);

  useEffect(() => {
    refreshRunning();
    const interval = setInterval(refreshRunning, RUNNING_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refreshRunning]);

  useEffect(() => {
    const timeouts = stoppingTimeouts.current;
    return () => timeouts.forEach((timeout) => clearTimeout(timeout));
  }, []);

  function markStopping(projectIds: string[]) {
    if (projectIds.length === 0) return;
    setStoppingProjectIds((prev) => {
      const next = new Set(prev);
      projectIds.forEach((id) => next.add(id));
      return next;
    });
    projectIds.forEach((id) => {
      const existing = stoppingTimeouts.current.get(id);
      if (existing) clearTimeout(existing);
      const timeout = setTimeout(() => {
        setStoppingProjectIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        stoppingTimeouts.current.delete(id);
      }, STOPPING_TIMEOUT_MS);
      stoppingTimeouts.current.set(id, timeout);
    });
  }

  function getStatus(projectId: string): ProjectRunStatus {
    if (stoppingProjectIds.has(projectId)) return 'stopping';
    if (runningProjectIds.has(projectId)) return 'running';
    return 'stopped';
  }

  const assignedIds = new Set(sections.flatMap((s) => s.projectIds));
  const unassignedProjects = projects.filter((p) => !assignedIds.has(p.id));

  async function handleAddSection() {
    // Cascata: cada seção nova nasce um pouco deslocada da anterior, em vez
    // de sempre no mesmo canto (senão empilha tudo exatamente no mesmo
    // lugar). Reinicia o ciclo depois de algumas pra não sair do canvas.
    const step = sections.length % CASCADE_STEPS;
    const offset = step * CASCADE_OFFSET;
    await api.createSection({
      name: 'Nova seção',
      position: { x: 40 + offset, y: 40 + offset, width: 320, height: 220 },
      projectIds: [],
    });
    await onSectionsChange();
  }

  async function handlePositionChange(sectionId: string, position: Section['position']) {
    await api.updateSection(sectionId, { position });
    await onSectionsChange();
  }

  async function handleRename(sectionId: string, name: string) {
    await api.updateSection(sectionId, { name });
    await onSectionsChange();
  }

  async function handleDeleteSection(sectionId: string) {
    if (!confirm('Excluir esta seção? Os projetos dentro dela voltam pra área "sem seção".')) return;
    await api.deleteSection(sectionId);
    await onSectionsChange();
  }

  async function handleDropProject(sectionId: string, projectId: string) {
    const updates: Promise<unknown>[] = [];
    for (const s of sections) {
      if (s.id !== sectionId && s.projectIds.includes(projectId)) {
        updates.push(api.updateSection(s.id, { projectIds: s.projectIds.filter((id) => id !== projectId) }));
      }
    }
    const target = sections.find((s) => s.id === sectionId);
    if (target && !target.projectIds.includes(projectId)) {
      updates.push(api.updateSection(sectionId, { projectIds: [...target.projectIds, projectId] }));
    }
    if (updates.length === 0) return;
    await Promise.all(updates);
    await onSectionsChange();
  }

  async function handleDropUnassigned(projectId: string) {
    const updates: Promise<unknown>[] = [];
    for (const s of sections) {
      if (s.projectIds.includes(projectId)) {
        updates.push(api.updateSection(s.id, { projectIds: s.projectIds.filter((id) => id !== projectId) }));
      }
    }
    if (updates.length === 0) return;
    await Promise.all(updates);
    await onSectionsChange();
  }

  return (
    <div className="projects-tab">
      <div className="projects-tab-toolbar">
        <h1>Projetos</h1>
        <div className="toolbar-actions">
          <button type="button" className="btn" onClick={handleAddSection}>
            + Nova seção
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setShowNewProject(true)}>
            + Novo projeto
          </button>
        </div>
      </div>

      <div className="canvas">
        {sections.map((section) => (
          <SectionBox
            key={section.id}
            section={section}
            projects={projects}
            getStatus={getStatus}
            onOpenDetail={onOpenDetail}
            onPositionChange={handlePositionChange}
            onDropProject={handleDropProject}
            onRename={handleRename}
            onDelete={handleDeleteSection}
            onRunningChange={refreshRunning}
            onStopped={markStopping}
            onToast={showToast}
          />
        ))}
      </div>

      <div
        className="unassigned-area"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const projectId = e.dataTransfer.getData('text/project-id');
          if (projectId) handleDropUnassigned(projectId);
        }}
      >
        <h2>Sem seção</h2>
        {projects.length === 0 && <p className="pending-note">Nenhum projeto cadastrado ainda — clique em "Novo projeto".</p>}
        {projects.length > 0 && unassignedProjects.length === 0 && (
          <p className="pending-note">Todos os projetos estão em alguma seção.</p>
        )}
        <div className="unassigned-list">
          {unassignedProjects.map((p) => (
            <ProjectCard key={p.id} project={p} status={getStatus(p.id)} onOpenDetail={onOpenDetail} />
          ))}
        </div>
      </div>

      {showNewProject && (
        <NewProjectModal
          onClose={() => setShowNewProject(false)}
          onCreate={async (input) => {
            await api.createProject(input);
            await onProjectsChange();
          }}
        />
      )}

      <ToastStack toasts={toasts} />
    </div>
  );
}
