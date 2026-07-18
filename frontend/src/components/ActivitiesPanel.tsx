import { useCallback, useEffect, useRef, useState } from 'react';
import { FiCheckCircle, FiCircle, FiLoader, FiX } from 'react-icons/fi';
import { api, ApiError } from '../api/client';
import type { Activity, ActivityStep, Project } from '../types';

const RUNNING_POLL_INTERVAL_MS = 5000;
const PROGRESS_POLL_INTERVAL_MS = 4000;
const MAX_MENTION_SUGGESTIONS = 5;

interface Props {
  projectId: string;
  hasFolders: boolean;
  projects: Project[];
}

interface FormState {
  title: string;
  prompt: string;
  startFromDevBranch: boolean;
  branchName: string;
}

const EMPTY_FORM: FormState = { title: '', prompt: '', startFromDevBranch: true, branchName: '' };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Um projeto foi "citado" se `@nome-do-projeto` aparece no prompt como token
// isolado (precedido de espaço/início e seguido de espaço/fim) — evita bater
// com nomes que são só substring de outro (ex: "ressona-backend" dentro de
// "ressona-backend-worker").
function extractMentionedProjectIds(text: string, candidates: Project[]): string[] {
  const found: string[] = [];
  for (const p of candidates) {
    const pattern = new RegExp(`(?:^|\\s)@${escapeRegExp(p.name)}(?=\\s|$)`, 'i');
    if (pattern.test(text)) found.push(p.id);
  }
  return found;
}

interface MentionTextareaProps {
  value: string;
  onChange: (value: string) => void;
  candidates: Project[];
  rows: number;
  placeholder?: string;
}

function MentionTextarea({ value, onChange, candidates, rows, placeholder }: MentionTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<string | null>(null);

  function updateQueryFromCursor(text: string, cursor: number) {
    const before = text.slice(0, cursor);
    const match = before.match(/(?:^|\s)@([a-zA-Z0-9_-]*)$/);
    setQuery(match ? match[1] : null);
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    onChange(e.target.value);
    updateQueryFromCursor(e.target.value, e.target.selectionStart);
  }

  const suggestions =
    query === null
      ? []
      : candidates.filter((p) => p.name.toLowerCase().startsWith(query.toLowerCase())).slice(0, MAX_MENTION_SUGGESTIONS);

  function applySuggestion(name: string) {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const cursor = textarea.selectionStart;
    const before = value.slice(0, cursor).replace(/@([a-zA-Z0-9_-]*)$/, `@${name} `);
    const after = value.slice(cursor);
    const newValue = before + after;
    onChange(newValue);
    setQuery(null);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(before.length, before.length);
    });
  }

  return (
    <div className="mention-textarea">
      <textarea
        ref={textareaRef}
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={handleChange}
        onKeyUp={(e) => updateQueryFromCursor(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
      />
      {query !== null && suggestions.length > 0 && (
        <ul className="mention-suggestions">
          {suggestions.map((p) => (
            <li key={p.id}>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); applySuggestion(p.name); }}>
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const STEP_ICON = {
  done: <FiCheckCircle className="activity-step-icon activity-step-done" />,
  in_progress: <FiLoader className="activity-step-icon activity-step-in-progress" />,
  pending: <FiCircle className="activity-step-icon activity-step-pending" />,
};

// O Claude Code não expõe API/hook pra acompanhar o plano dele de fora —
// por isso pedimos (via PROGRESS_INSTRUCTION no backend) pra ele mesmo
// manter um arquivo .claude-activity-status.json no projeto, e o pai
// (ActivitiesPanel) faz poll nesse arquivo e passa os steps como prop —
// componente sem estado próprio, pra uma adição/exclusão manual refletir
// na hora, sem esperar o próximo ciclo de poll.
interface ActivityProgressListProps {
  steps: ActivityStep[];
  onDeleteStep?: (title: string) => void;
}

function ActivityProgressList({ steps, onDeleteStep }: ActivityProgressListProps) {
  if (steps.length === 0) return null;

  return (
    <ul className="activity-steps">
      {steps.map((step, i) => (
        <li key={i} className={`activity-step activity-step-${step.status}`}>
          {STEP_ICON[step.status] ?? STEP_ICON.pending}
          <span>{step.title}</span>
          {step.source === 'user' && (
            <button
              type="button"
              className="activity-step-delete"
              title="Excluir esse subtask (criado manualmente)"
              onClick={() => onDeleteStep?.(step.title)}
            >
              <FiX />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

interface StartOriginChoiceProps {
  value: boolean;
  onChange: (value: boolean) => void;
  devBranch: string | null | undefined;
}

function StartOriginChoice({ value, onChange, devBranch }: StartOriginChoiceProps) {
  return (
    <label className="field">
      Vai iniciar a partir de
      <div className="activity-origin-choice">
        <label>
          <input type="radio" checked={value} onChange={() => onChange(true)} />
          {devBranch ?? 'branch de desenvolvimento'} (dá pull antes)
        </label>
        <label>
          <input type="radio" checked={!value} onChange={() => onChange(false)} />
          branch atual do projeto
        </label>
      </div>
    </label>
  );
}

export function ActivitiesPanel({ projectId, hasFolders, projects }: Props) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stepsByActivity, setStepsByActivity] = useState<Record<string, ActivityStep[]>>({});
  const [addingStepFor, setAddingStepFor] = useState<string | null>(null);
  const [newStepTitle, setNewStepTitle] = useState('');
  const [savingStep, setSavingStep] = useState(false);

  const otherProjects = projects.filter((p) => p.id !== projectId);
  const projectsById = new Map(projects.map((p) => [p.id, p]));
  const currentProjectDevBranch = projectsById.get(projectId)?.devBranch;

  const refresh = useCallback(async () => {
    setActivities(await api.listActivities(projectId));
  }, [projectId]);

  const refreshRunning = useCallback(async () => {
    const { activityIds } = await api.getRunningActivities();
    setRunningIds(new Set(activityIds));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    refreshRunning();
    const interval = setInterval(refreshRunning, RUNNING_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refreshRunning]);

  const startedActivityIds = activities.filter((a) => a.started).map((a) => a.id).join(',');

  useEffect(() => {
    const ids = startedActivityIds ? startedActivityIds.split(',') : [];
    if (ids.length === 0) return;
    let cancelled = false;
    async function pollProgress() {
      await Promise.all(
        ids.map(async (id) => {
          try {
            const { steps } = await api.getActivityProgress(id);
            if (!cancelled) setStepsByActivity((prev) => ({ ...prev, [id]: steps }));
          } catch {
            // arquivo pode não existir ainda, ou estar no meio de uma escrita — ignora
          }
        }),
      );
    }
    pollProgress();
    const interval = setInterval(pollProgress, PROGRESS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [startedActivityIds]);

  async function handleCreate() {
    if (!createForm.title.trim() || !createForm.prompt.trim()) return;
    if (createForm.startFromDevBranch && !createForm.branchName.trim()) return;
    await api.createActivity(projectId, {
      title: createForm.title.trim(),
      prompt: createForm.prompt.trim(),
      relatedProjectIds: extractMentionedProjectIds(createForm.prompt, otherProjects),
      startFromDevBranch: createForm.startFromDevBranch,
      branchName: createForm.startFromDevBranch ? createForm.branchName.trim() : '',
    });
    setCreateForm(EMPTY_FORM);
    setCreating(false);
    await refresh();
  }

  function startEditing(activity: Activity) {
    setEditingId(activity.id);
    setEditForm({
      title: activity.title,
      prompt: activity.prompt,
      startFromDevBranch: activity.startFromDevBranch,
      branchName: activity.branchName,
    });
  }

  async function handleSaveEdit(activityId: string) {
    if (!editForm.title.trim() || !editForm.prompt.trim()) return;
    if (editForm.startFromDevBranch && !editForm.branchName.trim()) return;
    await api.updateActivity(activityId, {
      title: editForm.title.trim(),
      prompt: editForm.prompt.trim(),
      relatedProjectIds: extractMentionedProjectIds(editForm.prompt, otherProjects),
      startFromDevBranch: editForm.startFromDevBranch,
      branchName: editForm.startFromDevBranch ? editForm.branchName.trim() : '',
    });
    setEditingId(null);
    await refresh();
  }

  async function handleDelete(activityId: string) {
    if (!confirm('Excluir esta atividade? A branch criada pra ela não é apagada, só o cadastro aqui.')) return;
    await api.deleteActivity(activityId);
    await refresh();
  }

  async function handleStart(activity: Activity) {
    setBusyId(activity.id);
    setError(null);
    try {
      await api.startActivity(activity.id);
      await Promise.all([refresh(), refreshRunning()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handlePause(activity: Activity) {
    setBusyId(activity.id);
    setError(null);
    try {
      const { sent } = await api.pauseActivity(activity.id);
      if (!sent) {
        setError('Não encontrei o terminal dessa atividade aberto — pode já ter sido fechado.');
      }
      await refreshRunning();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleConclude(activity: Activity) {
    setBusyId(activity.id);
    setError(null);
    try {
      const { terminalClosed } = await api.concludeActivity(activity.id);
      if (!terminalClosed) {
        setError('MR aberto, mas não consegui fechar o terminal sozinho — feche manualmente.');
      }
      await Promise.all([refresh(), refreshRunning()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleAddStep(activity: Activity) {
    const title = newStepTitle.trim();
    if (!title || savingStep) return;
    setError(null);
    setSavingStep(true);
    try {
      const { steps } = await api.addActivityStep(activity.id, title);
      setStepsByActivity((prev) => ({ ...prev, [activity.id]: steps }));
      setNewStepTitle('');
      setAddingStepFor(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSavingStep(false);
    }
  }

  async function handleDeleteStep(activity: Activity, title: string) {
    setError(null);
    try {
      const { steps } = await api.deleteActivityStep(activity.id, title);
      setStepsByActivity((prev) => ({ ...prev, [activity.id]: steps }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <section className="detail-section">
      <h2>Atividades com Claude</h2>
      {!hasFolders && (
        <p className="pending-note">Cadastre uma pasta pro projeto antes de criar atividades — o Claude roda dentro dela.</p>
      )}
      {error && <p className="pending-note field-error">{error}</p>}
      {!currentProjectDevBranch && (
        <p className="pending-note field-error">
          Configure a branch de desenvolvimento do projeto (aba Detalhar → Editar) antes de iniciar atividades.
        </p>
      )}

      {activities.length === 0 && !creating && <p className="pending-note">Nenhuma atividade cadastrada ainda.</p>}

      <ul className="activity-list">
        {activities.map((activity) => {
          const running = runningIds.has(activity.id);
          const busy = busyId === activity.id;
          if (editingId === activity.id) {
            return (
              <li key={activity.id} className="activity-item">
                <label className="field">
                  Título
                  <input value={editForm.title} onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))} />
                </label>
                <label className="field">
                  Prompt
                  <MentionTextarea
                    rows={3}
                    value={editForm.prompt}
                    onChange={(prompt) => setEditForm((f) => ({ ...f, prompt }))}
                    candidates={otherProjects}
                  />
                  <span className="field-hint">Digite @ pra citar outro projeto que também precisa mudar.</span>
                </label>
                {!activity.started && (
                  <>
                    <StartOriginChoice
                      value={editForm.startFromDevBranch}
                      onChange={(startFromDevBranch) => setEditForm((f) => ({ ...f, startFromDevBranch }))}
                      devBranch={currentProjectDevBranch}
                    />
                    {editForm.startFromDevBranch && (
                      <label className="field">
                        Nome da branch
                        <input
                          value={editForm.branchName}
                          onChange={(e) => setEditForm((f) => ({ ...f, branchName: e.target.value }))}
                          placeholder="ex: task/corrigir-login"
                        />
                      </label>
                    )}
                  </>
                )}
                <div className="modal-actions">
                  <button type="button" className="btn" onClick={() => setEditingId(null)}>
                    Cancelar
                  </button>
                  <button type="button" className="btn btn-primary" onClick={() => handleSaveEdit(activity.id)}>
                    Salvar
                  </button>
                </div>
              </li>
            );
          }
          const relatedNames = activity.relatedProjectIds.map((id) => projectsById.get(id)?.name).filter(Boolean) as string[];

          // "started" só marca que já rodou uma vez — não diz se tá rodando
          // agora. O rótulo/estado real cruza os dois: sem isso, dava pra
          // mostrar "Continuar" (desabilitado) ao mesmo tempo que a bolinha
          // dizia "rodando", o que é contraditório e confuso.
          const startLabel = !activity.started ? 'Iniciar' : running ? 'Em andamento' : 'Continuar';
          const statusLabel = running ? 'rodando agora' : activity.started ? 'pausada — terminal fechado' : null;
          const devBranch = currentProjectDevBranch;
          // Origem só é relevante mostrar antes da primeira vez que a
          // atividade roda (depois disso já tem sua própria branch com
          // histórico próprio, decidida lá atrás).
          const originLabel = !activity.started
            ? activity.startFromDevBranch
              ? `branch ${activity.branchName}, a partir de ${devBranch ?? '?'} (com pull)`
              : 'vai continuar na branch atual do projeto (sem criar branch nova)'
            : `branch: ${activity.branchName}`;
          // Branch de desenvolvimento é obrigatória pra iniciar/retomar
          // qualquer atividade — sem isso o app não sabe de onde a
          // atividade deveria partir.
          const startDisabled = !hasFolders || busy || running || !devBranch;
          const steps = stepsByActivity[activity.id] ?? [];
          const allStepsDone = steps.length > 0 && steps.every((s) => s.status === 'done');
          const canConclude = activity.started && allStepsDone;

          return (
            <li key={activity.id} className="activity-item">
              <div className="activity-header">
                <span
                  className={`running-dot ${running ? 'running-dot-on' : 'running-dot-off'}`}
                  title={running ? 'Terminal aberto' : 'Terminal fechado'}
                />
                <strong>{activity.title}</strong>
                {statusLabel && (
                  <span className={`activity-status ${running ? 'activity-status-running' : 'activity-status-paused'}`}>
                    {statusLabel}
                  </span>
                )}
                {activity.concluded && activity.mrUrl && (
                  <a className="activity-status activity-status-concluded" href={activity.mrUrl} target="_blank" rel="noreferrer">
                    Concluída — ver MR
                  </a>
                )}
              </div>
              <p className="activity-prompt">{activity.prompt}</p>
              {activity.started && (
                <ActivityProgressList steps={steps} onDeleteStep={(title) => handleDeleteStep(activity, title)} />
              )}
              {activity.started && addingStepFor === activity.id && (
                <div className="activity-add-step">
                  <input
                    autoFocus
                    value={newStepTitle}
                    disabled={savingStep}
                    onChange={(e) => setNewStepTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAddStep(activity);
                      if (e.key === 'Escape' && !savingStep) {
                        setAddingStepFor(null);
                        setNewStepTitle('');
                      }
                    }}
                    placeholder="O que falta ajustar?"
                  />
                  <button type="button" className="btn btn-primary" disabled={savingStep} onClick={() => handleAddStep(activity)}>
                    {savingStep ? 'Salvando…' : 'Adicionar'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={savingStep}
                    onClick={() => {
                      setAddingStepFor(null);
                      setNewStepTitle('');
                    }}
                  >
                    Cancelar
                  </button>
                </div>
              )}
              {relatedNames.length > 0 && (
                <p className="pending-note activity-related">Também mexe em: {relatedNames.join(', ')}</p>
              )}
              {originLabel && <p className="pending-note activity-related">{originLabel}</p>}
              <div className="activity-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={startDisabled}
                  title={!devBranch ? 'Configure a branch de desenvolvimento do projeto primeiro' : undefined}
                  onClick={() => handleStart(activity)}
                >
                  {busy ? '…' : startLabel}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={!running || busy}
                  title={
                    running
                      ? 'Pede pro Claude salvar o progresso (STATUS.md + commit/push) — a janela não fecha sozinha, você fecha depois que ele confirmar'
                      : 'Nenhum terminal aberto pra essa atividade agora'
                  }
                  onClick={() => handlePause(activity)}
                >
                  Pausar
                </button>
                {canConclude && (
                  <button
                    type="button"
                    className="btn btn-success"
                    disabled={busy}
                    title="Abre (ou reaproveita) um MR no GitLab e fecha o terminal — todos os passos do checklist já estão concluídos"
                    onClick={() => handleConclude(activity)}
                  >
                    {busy ? '…' : 'Concluir atividade'}
                  </button>
                )}
                {activity.started && addingStepFor !== activity.id && (
                  <button
                    type="button"
                    className="btn"
                    title="Registra um ajuste pendente no checklist — o 'Continuar' avisa o Claude sobre isso"
                    onClick={() => {
                      setAddingStepFor(activity.id);
                      setNewStepTitle('');
                    }}
                  >
                    + Subtask
                  </button>
                )}
                <button type="button" className="btn" onClick={() => startEditing(activity)}>
                  Editar
                </button>
                <button type="button" className="btn btn-danger" onClick={() => handleDelete(activity.id)}>
                  Excluir
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {creating ? (
        <div className="activity-item">
          <label className="field">
            Título
            <input
              value={createForm.title}
              onChange={(e) => setCreateForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="Ex: corrigir bug do login"
            />
          </label>
          <label className="field">
            Prompt
            <MentionTextarea
              rows={3}
              value={createForm.prompt}
              onChange={(prompt) => setCreateForm((f) => ({ ...f, prompt }))}
              candidates={otherProjects}
              placeholder="O que o Claude deve fazer nessa atividade. Digite @ pra citar outro projeto."
            />
          </label>
          <StartOriginChoice
            value={createForm.startFromDevBranch}
            onChange={(startFromDevBranch) => setCreateForm((f) => ({ ...f, startFromDevBranch }))}
            devBranch={currentProjectDevBranch}
          />
          {createForm.startFromDevBranch && (
            <label className="field">
              Nome da branch
              <input
                value={createForm.branchName}
                onChange={(e) => setCreateForm((f) => ({ ...f, branchName: e.target.value }))}
                placeholder="ex: task/corrigir-login"
              />
              <span className="field-hint">Branch que vai ser criada pra essa atividade — escolha um nome, não é gerado sozinho.</span>
            </label>
          )}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => { setCreating(false); setCreateForm(EMPTY_FORM); }}>
              Cancelar
            </button>
            <button type="button" className="btn btn-primary" onClick={handleCreate}>
              Criar
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => setCreating(true)}>
          + Nova atividade
        </button>
      )}
    </section>
  );
}
