import { useState } from 'react';
import { api } from '../api/client';
import type { Folder, Project } from '../types';
import { DevBranchSelect } from '../components/DevBranchSelect';
import { FolderListEditor } from '../components/FolderListEditor';
import { GitStatusBadge } from '../components/GitStatusBadge';

interface Props {
  project: Project | null;
  onProjectsChange: () => Promise<void>;
}

function OpenFolderButton({ path }: { path: string }) {
  const [opening, setOpening] = useState(false);

  async function handleClick() {
    if (opening) return;
    setOpening(true);
    try {
      await api.openVSCode([path]);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  }

  return (
    <button type="button" className="btn" disabled={opening} onClick={handleClick}>
      {opening ? '…' : 'Abrir no VS Code'}
    </button>
  );
}

export function ProjectDetailTab({ project, onProjectsChange }: Props) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project?.name ?? '');
  const [folders, setFolders] = useState<Folder[]>(project?.folders ?? []);
  const [runCommand, setRunCommand] = useState(project?.runCommand ?? '');
  const [devBranch, setDevBranch] = useState(project?.devBranch ?? '');
  const [prodBranch, setProdBranch] = useState(project?.prodBranch ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!project) {
    return <p className="pending-note">Este projeto foi removido.</p>;
  }

  function startEditing() {
    setName(project!.name);
    setFolders(project!.folders);
    setRunCommand(project!.runCommand ?? '');
    setDevBranch(project!.devBranch ?? '');
    setProdBranch(project!.prodBranch ?? '');
    setError(null);
    setEditing(true);
  }

  async function handleSave() {
    if (!name.trim()) {
      setError('O nome do projeto é obrigatório');
      return;
    }
    if (!devBranch.trim()) {
      setError('A branch de desenvolvimento é obrigatória');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.updateProject(project!.id, {
        name: name.trim(),
        folders: folders.filter((f) => f.name.trim() && f.path.trim()),
        runCommand: runCommand.trim() || undefined,
        devBranch: devBranch.trim(),
        prodBranch: prodBranch.trim() || undefined,
      });
      await onProjectsChange();
      setEditing(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Excluir o projeto "${project!.name}"? Isso não apaga as pastas em disco, só o cadastro.`)) return;
    await api.deleteProject(project!.id);
    await onProjectsChange();
  }

  if (editing) {
    return (
      <div className="detail-tab">
        <h1>Editar projeto</h1>
        <label className="field">
          Nome
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <FolderListEditor folders={folders} onChange={setFolders} />
        <label className="field">
          Branch de desenvolvimento
          <DevBranchSelect folderPath={folders[0]?.path.trim() || undefined} value={devBranch} onChange={setDevBranch} />
          <span className="field-hint">
            Obrigatória — é a partir dela que as atividades com Claude criam a branch de cada tarefa. Sem isso, não dá
            pra iniciar atividades neste projeto.
          </span>
        </label>
        <label className="field">
          Branch de produção (opcional)
          <DevBranchSelect folderPath={folders[0]?.path.trim() || undefined} value={prodBranch} onChange={setProdBranch} />
          <span className="field-hint">Útil pra atividades de bugfix que precisam intervir direto na branch principal.</span>
        </label>
        <label className="field">
          Comando de execução
          <textarea
            className="run-command-input"
            rows={3}
            value={runCommand}
            onChange={(e) => setRunCommand(e.target.value)}
            placeholder={'npm run dev\n\nou várias linhas, ex:\nsource .venv/bin/activate\nuvicorn app.main:app --reload'}
          />
          <span className="field-hint">Aceita múltiplas linhas — roda como um script shell quando a seção é iniciada.</span>
        </label>
        {error && <p className="pending-note field-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => setEditing(false)}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>
            {saving ? 'Salvando...' : 'Salvar'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="detail-tab">
      <div className="detail-header">
        <div className="detail-header-title">
          <h1>{project.name}</h1>
          <GitStatusBadge projectId={project.id} />
        </div>
        <div className="toolbar-actions">
          <button type="button" className="btn" onClick={startEditing}>
            Editar
          </button>
          <button type="button" className="btn btn-danger" onClick={handleDelete}>
            Excluir projeto
          </button>
        </div>
      </div>

      <section className="detail-section">
        <h2>Pastas</h2>
        {project.folders.length === 0 && <p className="pending-note">Nenhuma pasta cadastrada.</p>}
        <ul className="folder-list">
          {project.folders.map((folder) => (
            <li key={folder.path} className="folder-list-item">
              <div>
                <strong>{folder.name}</strong>
                <div className="folder-path">{folder.path}</div>
              </div>
              <OpenFolderButton path={folder.path} />
            </li>
          ))}
        </ul>
      </section>

      <section className="detail-section">
        <h2>Branch de desenvolvimento</h2>
        {project.devBranch ? (
          <pre className="run-command-view">{project.devBranch}</pre>
        ) : (
          <p className="pending-note field-error">
            Não configurada — não é possível iniciar atividades neste projeto sem isso.
          </p>
        )}
      </section>

      <section className="detail-section">
        <h2>Branch de produção</h2>
        {project.prodBranch ? (
          <pre className="run-command-view">{project.prodBranch}</pre>
        ) : (
          <p className="pending-note">Não configurada.</p>
        )}
      </section>

      <section className="detail-section">
        <h2>Comando de execução</h2>
        {project.runCommand ? (
          <pre className="run-command-view">{project.runCommand}</pre>
        ) : (
          <p className="pending-note">Não configurado — a seção não conseguirá iniciar este projeto (item 8 do arquitetura.md).</p>
        )}
      </section>
    </div>
  );
}
