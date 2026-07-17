import { useState } from 'react';
import { api } from '../api/client';
import type { Project } from '../types';

export type ProjectRunStatus = 'running' | 'stopping' | 'stopped';

interface Props {
  project: Project;
  status: ProjectRunStatus;
  onOpenDetail: (project: Project) => void;
}

const DOT_CLASS: Record<ProjectRunStatus, string> = {
  running: 'running-dot-on',
  stopping: 'running-dot-stopping',
  stopped: 'running-dot-off',
};

const DOT_TITLE: Record<ProjectRunStatus, string> = {
  running: 'Rodando (via launchd)',
  stopping: 'Desligando...',
  stopped: 'Não está rodando',
};

export function ProjectCard({ project, status, onOpenDetail }: Props) {
  const [openingVSCode, setOpeningVSCode] = useState(false);
  const hasFolders = project.folders.length > 0;

  async function handleOpenVSCode() {
    if (!hasFolders || openingVSCode) return;
    setOpeningVSCode(true);
    try {
      await api.openVSCode(project.folders.map((f) => f.path));
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setOpeningVSCode(false);
    }
  }

  return (
    <div
      className="project-card"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/project-id', project.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      <div className="project-card-header">
        <span className="project-card-name">{project.name}</span>
        <span className={`running-dot ${DOT_CLASS[status]}`} title={DOT_TITLE[status]} />
      </div>
      <p className="pending-note">Resumo do Trello: integração pendente</p>
      <div className="project-card-actions">
        <button
          type="button"
          className="btn"
          disabled={openingVSCode}
          aria-disabled={!hasFolders ? 'true' : undefined}
          title={hasFolders ? 'Abrir todas as pastas do projeto no VS Code' : 'Nenhuma pasta cadastrada'}
          onClick={handleOpenVSCode}
        >
          {openingVSCode ? '…' : 'Abrir no VS Code'}
        </button>
        <button type="button" className="btn" onClick={() => onOpenDetail(project)}>
          Detalhar
        </button>
      </div>
    </div>
  );
}
