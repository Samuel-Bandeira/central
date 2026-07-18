import { useState } from 'react';
import { FiInfo, FiTrash2 } from 'react-icons/fi';
import { SiClaudecode, SiTrello } from 'react-icons/si';
import { VscVscodeOutline } from 'react-icons/vsc';
import { api } from '../api/client';
import type { Project } from '../types';

export type ProjectRunStatus = 'running' | 'stopping' | 'stopped';

interface Props {
  project: Project;
  status: ProjectRunStatus;
  onOpenDetail: (project: Project) => void;
  onOpenActivities: (project: Project) => void;
  onOpenTrello: (project: Project) => void;
  onDelete: (projectId: string) => void;
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

export function ProjectCard({ project, status, onOpenDetail, onOpenActivities, onOpenTrello, onDelete }: Props) {
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
      <div className="project-card-actions">
        <button
          type="button"
          className="btn btn-icon"
          disabled={openingVSCode}
          aria-disabled={!hasFolders ? 'true' : undefined}
          aria-label="Abrir no VS Code"
          title={hasFolders ? 'Abrir todas as pastas do projeto no VS Code' : 'Nenhuma pasta cadastrada'}
          onClick={handleOpenVSCode}
        >
          {openingVSCode ? '…' : <VscVscodeOutline size={14} />}
        </button>
        <button
          type="button"
          className="btn btn-icon"
          aria-label="Detalhar"
          title="Ver detalhes do projeto"
          onClick={() => onOpenDetail(project)}
        >
          <FiInfo size={14} />
        </button>
        <button
          type="button"
          className="btn btn-icon"
          aria-label="Atividades com Claude"
          title="Atividades com Claude"
          onClick={() => onOpenActivities(project)}
        >
          <SiClaudecode size={14} />
        </button>
        <button
          type="button"
          className="btn btn-icon"
          aria-label="Trello"
          title="Trello"
          onClick={() => onOpenTrello(project)}
        >
          <SiTrello size={14} />
        </button>
        <button
          type="button"
          className="btn btn-danger btn-icon"
          aria-label="Excluir projeto"
          title="Excluir projeto"
          onClick={() => onDelete(project.id)}
        >
          <FiTrash2 size={14} />
        </button>
      </div>
    </div>
  );
}
