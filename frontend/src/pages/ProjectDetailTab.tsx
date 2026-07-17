import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Folder, Project, TrelloCards, TrelloSummary } from '../types';
import { FolderListEditor } from '../components/FolderListEditor';

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
  const [trelloBoardUrl, setTrelloBoardUrl] = useState(project?.trelloBoardUrl ?? '');
  const [runCommand, setRunCommand] = useState(project?.runCommand ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState<TrelloSummary | null>(null);
  const [cards, setCards] = useState<TrelloCards | null>(null);

  const projectId = project?.id ?? null;

  useEffect(() => {
    if (!projectId) return;
    api.getTrelloSummary(projectId).then(setSummary);
    api.getTrelloCards(projectId).then(setCards);
  }, [projectId]);

  if (!project) {
    return <p className="pending-note">Este projeto foi removido.</p>;
  }

  function startEditing() {
    setName(project!.name);
    setFolders(project!.folders);
    setTrelloBoardUrl(project!.trelloBoardUrl ?? '');
    setRunCommand(project!.runCommand ?? '');
    setError(null);
    setEditing(true);
  }

  async function handleSave() {
    if (!name.trim()) {
      setError('O nome do projeto é obrigatório');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.updateProject(project!.id, {
        name: name.trim(),
        folders: folders.filter((f) => f.name.trim() && f.path.trim()),
        trelloBoardUrl: trelloBoardUrl.trim() || undefined,
        runCommand: runCommand.trim() || undefined,
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
          Link do board no Trello
          <input value={trelloBoardUrl} onChange={(e) => setTrelloBoardUrl(e.target.value)} placeholder="https://trello.com/b/..." />
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
        <h1>{project.name}</h1>
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
        <h2>Comando de execução</h2>
        {project.runCommand ? (
          <pre className="run-command-view">{project.runCommand}</pre>
        ) : (
          <p className="pending-note">Não configurado — a seção não conseguirá iniciar este projeto (item 8 do arquitetura.md).</p>
        )}
      </section>

      <section className="detail-section">
        <h2>Resumo do Trello</h2>
        {!summary?.integrated ? (
          <p className="pending-note">Integração com Trello ainda não implementada.</p>
        ) : (
          <ul>
            {summary.lists.map((list) => (
              <li key={list.name}>
                {list.name}: {list.cardCount}
              </li>
            ))}
          </ul>
        )}
        <a
          className={`btn ${project.trelloBoardUrl ? '' : 'btn-link-disabled'}`}
          href={project.trelloBoardUrl ?? undefined}
          target="_blank"
          rel="noreferrer"
          aria-disabled={!project.trelloBoardUrl}
          onClick={(e) => {
            if (!project.trelloBoardUrl) e.preventDefault();
          }}
        >
          Abrir no Trello
        </a>
      </section>

      <section className="detail-section">
        <h2>Cards</h2>
        {!cards?.integrated ? (
          <p className="pending-note">Integração com Trello ainda não implementada — nenhum card pra listar.</p>
        ) : cards.cards.length === 0 ? (
          <p className="pending-note">Nenhum card encontrado.</p>
        ) : (
          <ul>
            {cards.cards.map((card) => (
              <li key={card.id}>
                {card.name} — {card.listName}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
