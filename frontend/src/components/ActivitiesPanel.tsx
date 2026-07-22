import { useCallback, useEffect, useState } from 'react';
import { FiFileText } from 'react-icons/fi';
import { api } from '../api/client';
import type { AcceptanceCriterion, Activity, ActivityStep, Project } from '../types';
import {
  AcceptanceCriteriaEditor,
  ActivityCard,
  EMPTY_FORM,
  MentionTextarea,
  RelatedOriginChoice,
  SpecPicker,
  StartOriginChoice,
  extractMentionedProjectIds,
  type FormState,
} from './ActivityCard';

const RUNNING_POLL_INTERVAL_MS = 5000;
const PROGRESS_POLL_INTERVAL_MS = 4000;

interface Props {
  projectId: string;
  hasFolders: boolean;
  projects: Project[];
  onOpenGraph: (activity: Activity) => void;
}

// Dialog dedicado pra "Task grande" (ver ActivityBlockGraph) — deliberadamente
// mais enxuto que FormState: sem prompt/@menção/anexo de imagem, porque a
// spec substitui tudo isso. Manter os dois formulários separados evita que
// um dialog só vire uma bagunça de campos condicionais.
interface BigTaskFormState {
  title: string;
  acceptanceCriteria: AcceptanceCriterion[];
  startFromDevBranch: boolean;
  branchName: string;
  pendingSpecFile: File | null;
}

const EMPTY_BIG_TASK_FORM: BigTaskFormState = {
  title: '',
  acceptanceCriteria: [],
  startFromDevBranch: true,
  branchName: '',
  pendingSpecFile: null,
};

function cleanCriteria(items: AcceptanceCriterion[]): AcceptanceCriterion[] {
  return items.map((c) => ({ ...c, text: c.text.trim() })).filter((c) => c.text);
}

export function ActivitiesPanel({ projectId, hasFolders, projects, onOpenGraph }: Props) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [needsAttentionIds, setNeedsAttentionIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState<FormState>(EMPTY_FORM);
  const [creatingBigTask, setCreatingBigTask] = useState(false);
  const [bigTaskForm, setBigTaskForm] = useState<BigTaskFormState>(EMPTY_BIG_TASK_FORM);
  const [stepsByActivity, setStepsByActivity] = useState<Record<string, ActivityStep[]>>({});
  const [summaryByActivity, setSummaryByActivity] = useState<Record<string, string>>({});
  // "Em progresso" inclui até as que nunca foram iniciadas — só "Concluída"
  // de verdade (MR aberto) sai dessa aba. Padrão "progress" porque é o que
  // importa no dia a dia; "Concluídas" só cresce e é consultada por escolha.
  const [activityTab, setActivityTab] = useState<'progress' | 'done'>('progress');

  const otherProjects = projects.filter((p) => p.id !== projectId);
  const projectsById = new Map(projects.map((p) => [p.id, p]));
  const currentProjectDevBranch = projectsById.get(projectId)?.devBranch;

  const refresh = useCallback(async () => {
    setActivities(await api.listActivities(projectId));
  }, [projectId]);

  const refreshRunning = useCallback(async () => {
    const { activityIds, needsAttentionIds } = await api.getRunningActivities();
    setRunningIds(new Set(activityIds));
    setNeedsAttentionIds(new Set(needsAttentionIds));
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
            const { steps, summary } = await api.getActivityProgress(id);
            if (!cancelled) {
              setStepsByActivity((prev) => ({ ...prev, [id]: steps }));
              setSummaryByActivity((prev) => ({ ...prev, [id]: summary }));
            }
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
    const activity = await api.createActivity(projectId, {
      title: createForm.title.trim(),
      prompt: createForm.prompt.trim(),
      acceptanceCriteria: cleanCriteria(createForm.acceptanceCriteria),
      relatedProjectIds: extractMentionedProjectIds(createForm.prompt, otherProjects),
      startFromDevBranch: createForm.startFromDevBranch,
      branchName: createForm.startFromDevBranch ? createForm.branchName.trim() : '',
      relatedStartFromDevBranch: createForm.relatedStartFromDevBranch,
    });
    // Só dá pra anexar imagem depois de existir um id — a atividade acabou
    // de nascer na chamada acima.
    if (createForm.pendingFiles.length > 0) {
      await api.uploadActivityAttachments(activity.id, createForm.pendingFiles);
    }
    setCreateForm(EMPTY_FORM);
    setCreating(false);
    await refresh();
  }

  async function handleCreateBigTask() {
    if (!bigTaskForm.title.trim() || !bigTaskForm.pendingSpecFile) return;
    if (bigTaskForm.startFromDevBranch && !bigTaskForm.branchName.trim()) return;
    const activity = await api.createActivity(projectId, {
      title: bigTaskForm.title.trim(),
      prompt: '',
      acceptanceCriteria: cleanCriteria(bigTaskForm.acceptanceCriteria),
      relatedProjectIds: [],
      startFromDevBranch: bigTaskForm.startFromDevBranch,
      branchName: bigTaskForm.startFromDevBranch ? bigTaskForm.branchName.trim() : '',
      relatedStartFromDevBranch: true,
    });
    // Spec só dá pra anexar depois de existir um id — a atividade acabou de
    // nascer na chamada acima (mesma limitação do anexo de imagem).
    await api.uploadActivitySpec(activity.id, bigTaskForm.pendingSpecFile);
    setBigTaskForm(EMPTY_BIG_TASK_FORM);
    setCreatingBigTask(false);
    await refresh();
  }

  return (
    <section className="detail-section">
      <h2>Atividades com Claude</h2>
      {!hasFolders && (
        <p className="pending-note">Cadastre uma pasta pro projeto antes de criar atividades — o Claude roda dentro dela.</p>
      )}
      {!currentProjectDevBranch && (
        <p className="pending-note field-error">
          Configure a branch de desenvolvimento do projeto (aba Detalhar → Editar) antes de iniciar atividades.
        </p>
      )}

      {activities.length === 0 && !creating && <p className="pending-note">Nenhuma atividade cadastrada ainda.</p>}

      {activities.length > 0 && (() => {
        const concludedCount = activities.filter((a) => a.concluded).length;
        const progressCount = activities.length - concludedCount;
        return (
          <div className="activities-tabs">
            <button
              type="button"
              className={`activities-tab ${activityTab === 'progress' ? 'activities-tab-active' : ''}`}
              onClick={() => setActivityTab('progress')}
            >
              Em progresso ({progressCount})
            </button>
            <button
              type="button"
              className={`activities-tab ${activityTab === 'done' ? 'activities-tab-active' : ''}`}
              onClick={() => setActivityTab('done')}
            >
              Concluídas ({concludedCount})
            </button>
          </div>
        );
      })()}

      <ul className="activity-list">
        {activities
          .filter((activity) => (activityTab === 'done' ? activity.concluded : !activity.concluded))
          .map((activity) => (
            <ActivityCard
              key={activity.id}
              activity={activity}
              hasFolders={hasFolders}
              devBranch={currentProjectDevBranch}
              otherProjects={otherProjects}
              projectsById={projectsById}
              running={runningIds.has(activity.id)}
              needsAttention={runningIds.has(activity.id) && needsAttentionIds.has(activity.id)}
              steps={stepsByActivity[activity.id] ?? []}
              onStepsChange={(steps) => setStepsByActivity((prev) => ({ ...prev, [activity.id]: steps }))}
              summary={summaryByActivity[activity.id] ?? ''}
              onChanged={refresh}
              onRefreshRunning={refreshRunning}
              onOpenGraph={onOpenGraph}
            />
          ))}
      </ul>

      {activities.length > 0 &&
        activities.filter((a) => (activityTab === 'done' ? a.concluded : !a.concluded)).length === 0 && (
          <p className="pending-note">
            {activityTab === 'done' ? 'Nenhuma atividade concluída ainda.' : 'Nenhuma atividade em progresso.'}
          </p>
        )}

      <div className="activities-new-buttons">
        <button type="button" className="btn" onClick={() => setCreating(true)}>
          + Nova atividade
        </button>
        <button
          type="button"
          className="btn"
          title="Anexe um .md de spec grande e o Claude quebra sozinho em blocos interligados"
          onClick={() => setCreatingBigTask(true)}
        >
          <FiFileText size={14} /> Task grande
        </button>
      </div>

      {creating && (
        <div className="modal-overlay" onClick={() => { setCreating(false); setCreateForm(EMPTY_FORM); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Nova atividade</h2>
            <label className="field">
              Título
              <input
                value={createForm.title}
                onChange={(e) => setCreateForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="Ex: corrigir bug do login"
                autoFocus
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
                onImageFiles={(files) => setCreateForm((f) => ({ ...f, pendingFiles: [...f.pendingFiles, ...files] }))}
              />
              <span className="field-hint">Cole ou arraste uma imagem pra anexar ao prompt.</span>
            </label>
            <label className="field">
              Critérios de aceite (opcional)
              <AcceptanceCriteriaEditor
                items={createForm.acceptanceCriteria}
                onChange={(acceptanceCriteria) => setCreateForm((f) => ({ ...f, acceptanceCriteria }))}
              />
              <span className="field-hint">
                O "pronto" fixado da tarefa — diferente do checklist de passos, só você marca cada um como atendido, e
                "Concluir atividade" só libera quando todos estiverem.
              </span>
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
            <RelatedOriginChoice
              value={createForm.relatedStartFromDevBranch}
              onChange={(relatedStartFromDevBranch) => setCreateForm((f) => ({ ...f, relatedStartFromDevBranch }))}
              relatedNames={extractMentionedProjectIds(createForm.prompt, otherProjects)
                .map((id) => projectsById.get(id)?.name)
                .filter(Boolean) as string[]}
            />
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => { setCreating(false); setCreateForm(EMPTY_FORM); }}>
                Cancelar
              </button>
              <button type="button" className="btn btn-primary" onClick={handleCreate}>
                Criar
              </button>
            </div>
          </div>
        </div>
      )}

      {creatingBigTask && (
        <div className="modal-overlay" onClick={() => { setCreatingBigTask(false); setBigTaskForm(EMPTY_BIG_TASK_FORM); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Nova task grande</h2>
            <label className="field">
              Título
              <input
                value={bigTaskForm.title}
                onChange={(e) => setBigTaskForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="Ex: telas do onboarding"
                autoFocus
              />
            </label>
            <label className="field">
              Spec (.md)
              <SpecPicker
                existing={null}
                pendingFile={bigTaskForm.pendingSpecFile}
                onPick={(file) => setBigTaskForm((f) => ({ ...f, pendingSpecFile: file }))}
                onRemovePending={() => setBigTaskForm((f) => ({ ...f, pendingSpecFile: null }))}
              />
              <span className="field-hint">
                O Claude lê esse arquivo, quebra o trabalho em blocos interligados e espera sua validação entre um
                bloco e outro — acompanhe pelo diagrama que aparece no card depois de Iniciar.
              </span>
            </label>
            <label className="field">
              Critérios de aceite (opcional)
              <AcceptanceCriteriaEditor
                items={bigTaskForm.acceptanceCriteria}
                onChange={(acceptanceCriteria) => setBigTaskForm((f) => ({ ...f, acceptanceCriteria }))}
              />
              <span className="field-hint">O "pronto" da task inteira — só você marca cada um como atendido.</span>
            </label>
            <StartOriginChoice
              value={bigTaskForm.startFromDevBranch}
              onChange={(startFromDevBranch) => setBigTaskForm((f) => ({ ...f, startFromDevBranch }))}
              devBranch={currentProjectDevBranch}
            />
            {bigTaskForm.startFromDevBranch && (
              <label className="field">
                Nome da branch
                <input
                  value={bigTaskForm.branchName}
                  onChange={(e) => setBigTaskForm((f) => ({ ...f, branchName: e.target.value }))}
                  placeholder="ex: task/telas-onboarding"
                />
                <span className="field-hint">Branch que vai ser criada pra essa task — escolha um nome, não é gerado sozinho.</span>
              </label>
            )}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => { setCreatingBigTask(false); setBigTaskForm(EMPTY_BIG_TASK_FORM); }}>
                Cancelar
              </button>
              <button type="button" className="btn btn-primary" onClick={handleCreateBigTask}>
                Criar
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
