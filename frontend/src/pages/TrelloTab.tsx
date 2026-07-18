import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Project, TrelloCards, TrelloSummary } from '../types';

interface Props {
  project: Project | null;
  onProjectsChange: () => Promise<void>;
}

export function TrelloTab({ project, onProjectsChange }: Props) {
  const [summary, setSummary] = useState<TrelloSummary | null>(null);
  const [cards, setCards] = useState<TrelloCards | null>(null);
  const [boardUrl, setBoardUrl] = useState(project?.trelloBoardUrl ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectId = project?.id ?? null;

  useEffect(() => {
    if (!projectId) return;
    api.getTrelloSummary(projectId).then(setSummary);
    api.getTrelloCards(projectId).then(setCards);
  }, [projectId]);

  useEffect(() => {
    setBoardUrl(project?.trelloBoardUrl ?? '');
  }, [project?.trelloBoardUrl]);

  if (!project) {
    return <p className="pending-note">Este projeto foi removido.</p>;
  }

  async function handleSaveBoardUrl() {
    setSaving(true);
    setError(null);
    try {
      await api.updateProject(project!.id, { trelloBoardUrl: boardUrl.trim() || undefined });
      await onProjectsChange();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="detail-tab">
      <div className="detail-header">
        <h1>{project.name}</h1>
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
      </div>

      <section className="detail-section">
        <h2>Configuração</h2>
        <label className="field">
          Link do board no Trello
          <input value={boardUrl} onChange={(e) => setBoardUrl(e.target.value)} placeholder="https://trello.com/b/..." />
        </label>
        {error && <p className="pending-note field-error">{error}</p>}
        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || boardUrl.trim() === (project.trelloBoardUrl ?? '')}
            onClick={handleSaveBoardUrl}
          >
            {saving ? 'Salvando...' : 'Salvar'}
          </button>
        </div>
      </section>

      <section className="detail-section">
        <h2>Resumo</h2>
        {!summary?.integrated ? (
          <p className="pending-note">
            Integração com Trello ainda não implementada
            {!project.trelloBoardUrl && ' — cadastre o link do board acima primeiro'}.
          </p>
        ) : (
          <ul>
            {summary.lists.map((list) => (
              <li key={list.name}>
                {list.name}: {list.cardCount}
              </li>
            ))}
          </ul>
        )}
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
