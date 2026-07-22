import { useEffect, useRef, useState } from 'react';
import {
  FiCheckSquare,
  FiCornerUpRight,
  FiEdit3,
  FiFileText,
  FiMaximize2,
  FiMinusCircle,
  FiPlusCircle,
  FiRefreshCw,
  FiSquare,
  FiX,
} from 'react-icons/fi';
import { api, ApiError } from '../api/client';
import type { AcceptanceCriterion, Activity, ActivityDiffFile, ActivityStep, Project } from '../types';
import { ActivityBlockGraph } from './ActivityBlockGraph';
import { ActivityProgressList, AttachmentPicker, ReadOnlyAttachments, extractImageFiles } from './activityShared';

const MAX_MENTION_SUGGESTIONS = 5;

export interface FormState {
  title: string;
  prompt: string;
  acceptanceCriteria: AcceptanceCriterion[];
  startFromDevBranch: boolean;
  branchName: string;
  relatedStartFromDevBranch: boolean;
  // Já salvos no backend (só existe algo aqui ao editar uma atividade que
  // já tinha anexo) — remover um desses chama a API na hora.
  attachments: string[];
  // Selecionados agora, ainda não enviados — enviados de fato só quando o
  // form é salvo (Criar/Salvar), porque na criação a atividade ainda nem
  // tem id pra anexar nada antes disso.
  pendingFiles: File[];
  // Mesma lógica de attachments/pendingFiles, mas pro .md de spec que ativa
  // o "modo blocos" — só um arquivo por atividade, e só antes de iniciar.
  specFile: string | null;
  pendingSpecFile: File | null;
}

export const EMPTY_FORM: FormState = {
  title: '',
  prompt: '',
  acceptanceCriteria: [],
  startFromDevBranch: true,
  branchName: '',
  relatedStartFromDevBranch: true,
  attachments: [],
  pendingFiles: [],
  specFile: null,
  pendingSpecFile: null,
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Um projeto foi "citado" se `@nome-do-projeto` aparece no prompt como token
// isolado (precedido de espaço/início e seguido de espaço/fim) — evita bater
// com nomes que são só substring de outro (ex: "ressona-backend" dentro de
// "ressona-backend-worker").
export function extractMentionedProjectIds(text: string, candidates: Project[]): string[] {
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
  // Mesmo comportamento do chat da claude.ai: colar uma imagem do
  // clipboard ou arrastar um arquivo pro texto vira anexo, não texto.
  onImageFiles?: (files: File[]) => void;
}

export function MentionTextarea({ value, onChange, candidates, rows, placeholder, onImageFiles }: MentionTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

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
    <div className={`mention-textarea ${dragOver ? 'mention-textarea-drag-over' : ''}`}>
      <textarea
        ref={textareaRef}
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={handleChange}
        onKeyUp={(e) => updateQueryFromCursor(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
        onPaste={(e) => {
          const files = extractImageFiles(e.clipboardData);
          if (files.length > 0 && onImageFiles) {
            e.preventDefault();
            onImageFiles(files);
          }
        }}
        onDragOver={(e) => {
          if (!onImageFiles) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          if (!onImageFiles) return;
          const files = extractImageFiles(e.dataTransfer);
          if (files.length > 0) {
            e.preventDefault();
            onImageFiles(files);
          }
          setDragOver(false);
        }}
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

interface SpecPickerProps {
  existing: string | null;
  pendingFile: File | null;
  onPick: (file: File) => void;
  onRemovePending: () => void;
  onRemoveExisting?: () => void;
}

// Anexo do .md de spec que ativa o "modo blocos" (ver ActivityBlockGraph) —
// um arquivo só, mesma ideia de dois estágios do AttachmentPicker (pendente
// até o form salvar / já salvo no backend).
export function SpecPicker({ existing, pendingFile, onPick, onRemovePending, onRemoveExisting }: SpecPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const currentName = pendingFile?.name ?? (existing ? existing.split('/').pop() : null);

  function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onPick(file);
    e.target.value = '';
  }

  if (currentName) {
    return (
      <div className="spec-picker spec-picker-current">
        <FiFileText size={14} />
        <span>{currentName}</span>
        <button
          type="button"
          className="attachment-remove"
          aria-label="Remover spec"
          onClick={pendingFile ? onRemovePending : onRemoveExisting}
        >
          <FiX size={12} />
        </button>
      </div>
    );
  }

  return (
    <div className="spec-picker">
      <input ref={inputRef} type="file" accept=".md,text/markdown" hidden onChange={handlePick} />
      <button type="button" className="btn attachment-picker-btn" onClick={() => inputRef.current?.click()}>
        <FiFileText size={14} /> Anexar spec (.md)
      </button>
    </div>
  );
}

interface AcceptanceCriteriaEditorProps {
  items: AcceptanceCriterion[];
  onChange: (items: AcceptanceCriterion[]) => void;
}

// Edita o texto dos critérios (título/prompt da atividade). O status "met"
// não se mexe aqui — ele só muda pelo checklist ao vivo no card (ver
// AcceptanceCriteriaList), porque é uma confirmação minha sobre o trabalho
// já feito, não parte da redação da tarefa.
export function AcceptanceCriteriaEditor({ items, onChange }: AcceptanceCriteriaEditorProps) {
  return (
    <div className="acceptance-criteria-editor">
      {items.map((c, i) => (
        <div key={i} className="acceptance-criteria-editor-row">
          <input
            value={c.text}
            placeholder="Ex: GET /projetos/:id retorna 404 se não existir"
            onChange={(e) => onChange(items.map((item, idx) => (idx === i ? { ...item, text: e.target.value } : item)))}
          />
          <button
            type="button"
            className="btn btn-icon"
            aria-label="Remover critério"
            onClick={() => onChange(items.filter((_, idx) => idx !== i))}
          >
            <FiX size={14} />
          </button>
        </div>
      ))}
      <button type="button" className="btn" onClick={() => onChange([...items, { text: '', met: false }])}>
        + Critério de aceite
      </button>
    </div>
  );
}

interface AcceptanceCriteriaListProps {
  criteria: AcceptanceCriterion[];
  onToggle: (index: number) => void;
}

// Checklist ao vivo no card — diferente do ActivityProgressList (plano do
// Claude), esse é o "pronto" fixado por mim antes de começar. Só eu marco
// (o Claude é instruído a nunca escrever nesse campo), por isso aqui é
// clicável em vez de só refletir um arquivo que o Claude mantém.
function AcceptanceCriteriaList({ criteria, onToggle }: AcceptanceCriteriaListProps) {
  if (criteria.length === 0) return null;
  return (
    <ul className="acceptance-criteria-list">
      {criteria.map((c, i) => (
        <li key={i} className={`acceptance-criterion ${c.met ? 'acceptance-criterion-met' : ''}`}>
          <button
            type="button"
            className="acceptance-criterion-toggle"
            aria-pressed={c.met}
            title={c.met ? 'Marcar como não atendido' : 'Marcar como atendido'}
            onClick={() => onToggle(i)}
          >
            {c.met ? <FiCheckSquare /> : <FiSquare />}
            <span>{c.text}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

const DIFF_STATUS_ICON: Record<ActivityDiffFile['status'], React.ReactNode> = {
  added: <FiPlusCircle className="activity-diff-icon activity-diff-icon-added" />,
  modified: <FiEdit3 className="activity-diff-icon activity-diff-icon-modified" />,
  deleted: <FiMinusCircle className="activity-diff-icon activity-diff-icon-deleted" />,
  renamed: <FiCornerUpRight className="activity-diff-icon activity-diff-icon-renamed" />,
};

interface ActivityDiffSummaryBoxProps {
  files: ActivityDiffFile[];
  loading: boolean;
  onRefresh: () => void;
}

// Lista real de arquivos que a atividade tocou, calculada via `git diff`
// no backend (GET /activities/{id}/diff-summary) — diferente do "summary"
// (prosa do Claude sobre o que/porquê), essa aqui não depende dele lembrar
// certo cada arquivo numa spec grande com muitos blocos: é o próprio git.
// Sem poll automático (é um subprocess de git a cada chamada) — busca uma
// vez quando a atividade começa e tem um botão de atualizar manual.
function ActivityDiffSummaryBox({ files, loading, onRefresh }: ActivityDiffSummaryBoxProps) {
  const [expanded, setExpanded] = useState(false);
  if (files.length === 0 && !loading) return null;

  return (
    <div className="activity-diff-summary">
      <button type="button" className="activity-diff-summary-toggle" onClick={() => setExpanded((v) => !v)}>
        <span>{loading ? 'Calculando arquivos alterados…' : `Arquivos alterados (${files.length})`}</span>
      </button>
      <button
        type="button"
        className="btn btn-icon activity-diff-summary-refresh"
        aria-label="Atualizar lista de arquivos alterados"
        title="Atualizar lista de arquivos alterados"
        onClick={onRefresh}
        disabled={loading}
      >
        <FiRefreshCw size={13} />
      </button>
      {expanded && (
        <ul className="activity-diff-summary-list">
          {files.map((f) => (
            <li key={f.path}>
              {DIFF_STATUS_ICON[f.status]}
              <span>
                {f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface StartOriginChoiceProps {
  value: boolean;
  onChange: (value: boolean) => void;
  devBranch: string | null | undefined;
}

export function StartOriginChoice({ value, onChange, devBranch }: StartOriginChoiceProps) {
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

interface RelatedOriginChoiceProps {
  value: boolean;
  onChange: (value: boolean) => void;
  relatedNames: string[];
}

// Mesma decisão que StartOriginChoice, mas pros projetos citados com @ no
// prompt — cada um tem sua própria dev branch, então não dá pra reusar o
// mesmo componente (não existe uma única "devBranch" pra mostrar aqui).
export function RelatedOriginChoice({ value, onChange, relatedNames }: RelatedOriginChoiceProps) {
  if (relatedNames.length === 0) return null;
  return (
    <label className="field">
      Projetos relacionados ({relatedNames.join(', ')}) vão iniciar a partir de
      <div className="activity-origin-choice">
        <label>
          <input type="radio" checked={value} onChange={() => onChange(true)} />
          da própria branch de desenvolvimento de cada um (dá pull, cria branch nova de mesmo nome)
        </label>
        <label>
          <input type="radio" checked={!value} onChange={() => onChange(false)} />
          da branch em que cada um já estiver
        </label>
      </div>
    </label>
  );
}

function cleanCriteria(items: AcceptanceCriterion[]): AcceptanceCriterion[] {
  return items.map((c) => ({ ...c, text: c.text.trim() })).filter((c) => c.text);
}

export interface ActivityCardProps {
  activity: Activity;
  hasFolders: boolean;
  devBranch: string | null | undefined;
  otherProjects: Project[];
  projectsById: Map<string, Project>;
  running: boolean;
  needsAttention: boolean;
  steps: ActivityStep[];
  onStepsChange: (steps: ActivityStep[]) => void;
  // Visão geral que o Claude mantém sobre a atividade (ver
  // SUMMARY_FIELD_INSTRUCTION no backend) — string vazia até ele escrever
  // o primeiro entendimento. Sobrevive à fragmentação do checklist em
  // passos/blocos miúdos, é o que dá o contexto do todo.
  summary: string;
  // Recarrega os dados da atividade (ou da lista inteira, dependendo de
  // quem chama) — chamado depois de qualquer operação que muda a atividade.
  onChanged: () => Promise<void>;
  onRefreshRunning: () => Promise<void>;
  // Presente só na lista compacta (ActivitiesPanel) — abre o diagrama numa
  // aba própria, em tamanho real. Ausente quando o card já ESTÁ nessa aba
  // (ActivityGraphTab), onde o diagrama já ocupa o espaço disponível.
  onOpenGraph?: (activity: Activity) => void;
}

// Card de uma atividade — usado tanto na lista compacta (ActivitiesPanel)
// quanto sozinho na aba de diagrama em tela cheia (ActivityGraphTab), pra
// não perder nenhuma ação (subtasks, critérios de aceite, editar, etc) só
// porque o diagrama ganhou uma tela dedicada. O tamanho do grafo em si é
// resolvido via CSS (a aba de diagrama sobrescreve `.activity-block-graph`
// pra ocupar o espaço vertical disponível), não por uma prop de variante.
export function ActivityCard({
  activity,
  hasFolders,
  devBranch,
  otherProjects,
  projectsById,
  running,
  needsAttention,
  steps,
  onStepsChange,
  summary,
  onChanged,
  onRefreshRunning,
  onOpenGraph,
}: ActivityCardProps) {
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [concludeResult, setConcludeResult] = useState<{
    mrUrl: string;
    created: boolean;
    relatedMrs: { projectId: string; projectName: string; mrUrl: string; created: boolean }[];
  } | null>(null);
  const [addingStep, setAddingStep] = useState(false);
  const [newStepTitle, setNewStepTitle] = useState('');
  const [newStepFiles, setNewStepFiles] = useState<File[]>([]);
  const [savingStep, setSavingStep] = useState(false);
  // Bloco novo de verdade (nó próprio no diagrama, com dependsOn) — não
  // confundir com "+ Subtask" acima, que só adiciona um passo solto ou
  // amarrado a um bloco JÁ existente. Só faz sentido em atividades no
  // modo blocos (ver activity.specFile mais abaixo).
  const [addingBlock, setAddingBlock] = useState(false);
  const [newBlockTitle, setNewBlockTitle] = useState('');
  const [newBlockDependsOn, setNewBlockDependsOn] = useState<string[]>([]);
  // Spec própria desse bloco (opcional) — mesma ideia do specFile da
  // atividade inteira, só que escopada a este bloco só (ex: o backend
  // mandou um .md novo dos endpoints reais, isso vira o escopo de um
  // bloco de ajuste em vez de eu ter que colar o conteúdo em algum lugar).
  const [newBlockSpecFile, setNewBlockSpecFile] = useState<File | null>(null);
  const [savingBlock, setSavingBlock] = useState(false);
  // Setado quando o bloco foi criado mas o aviso não foi mandado (Claude
  // parecia ocupado) — diferente de "Liberar", clicar de novo em
  // "Adicionar bloco" criaria um bloco duplicado, então o retry usa um
  // endpoint separado que só reenvia o aviso pro bloco já existente.
  const [pendingBlockNotify, setPendingBlockNotify] = useState<{ id: string; title: string } | null>(null);
  const [notifyingBlock, setNotifyingBlock] = useState(false);
  const [validatingStepId, setValidatingStepId] = useState<string | null>(null);
  const [releasingStepId, setReleasingStepId] = useState<string | null>(null);
  // Setado quando o backend acha (best-effort) que o Claude está
  // ativamente trabalhando agora — mandar o aviso de liberação envolve um
  // Esc automatizado que pode interromper esse turno. Primeiro clique fica
  // parado aqui pedindo confirmação; um segundo clique no MESMO bloco
  // reenvia com confirm=true, ignorando a checagem.
  const [confirmReleaseStepId, setConfirmReleaseStepId] = useState<string | null>(null);
  // Confirmação do clique em si — separada da pill "liberado" que fica no
  // card do bloco (essa é permanente, não pode dizer "aguarde" pra sempre;
  // ver flowStatusOf em ActivityBlockGraph). Só aparece na hora, some na
  // próxima ação.
  const [releaseFeedback, setReleaseFeedback] = useState<string | null>(null);
  const [diffFiles, setDiffFiles] = useState<ActivityDiffFile[]>([]);
  const [loadingDiff, setLoadingDiff] = useState(false);

  async function refreshDiffSummary() {
    setLoadingDiff(true);
    try {
      const { files } = await api.getActivityDiffSummary(activity.id);
      setDiffFiles(files);
    } catch {
      // é um extra informativo (git diff) — falha aqui não deveria travar a tela
    } finally {
      setLoadingDiff(false);
    }
  }

  // Sem poll contínuo (cada chamada roda `git diff` de verdade) — busca
  // uma vez quando a atividade passa a existir/estar iniciada, e de novo
  // manualmente via o botão de atualizar (ver ActivityDiffSummaryBox).
  useEffect(() => {
    if (activity.started) refreshDiffSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity.id, activity.started]);

  function startEditing() {
    setEditForm({
      title: activity.title,
      prompt: activity.prompt,
      acceptanceCriteria: activity.acceptanceCriteria,
      startFromDevBranch: activity.startFromDevBranch,
      branchName: activity.branchName,
      relatedStartFromDevBranch: activity.relatedStartFromDevBranch,
      attachments: activity.attachments,
      pendingFiles: [],
      specFile: activity.specFile,
      pendingSpecFile: null,
    });
    setEditing(true);
  }

  async function handleSaveEdit() {
    if (!editForm.title.trim()) return;
    if (!editForm.prompt.trim() && !editForm.specFile && !editForm.pendingSpecFile) return;
    if (editForm.startFromDevBranch && !editForm.branchName.trim()) return;
    await api.updateActivity(activity.id, {
      title: editForm.title.trim(),
      prompt: editForm.prompt.trim(),
      acceptanceCriteria: cleanCriteria(editForm.acceptanceCriteria),
      relatedProjectIds: extractMentionedProjectIds(editForm.prompt, otherProjects),
      startFromDevBranch: editForm.startFromDevBranch,
      branchName: editForm.startFromDevBranch ? editForm.branchName.trim() : '',
      relatedStartFromDevBranch: editForm.relatedStartFromDevBranch,
    });
    if (editForm.pendingFiles.length > 0) {
      await api.uploadActivityAttachments(activity.id, editForm.pendingFiles);
    }
    if (editForm.pendingSpecFile) {
      await api.uploadActivitySpec(activity.id, editForm.pendingSpecFile);
    }
    setEditing(false);
    await onChanged();
  }

  async function handleRemoveAttachment(path: string) {
    setError(null);
    try {
      const { attachments } = await api.deleteActivityAttachment(activity.id, path);
      setEditForm((f) => ({ ...f, attachments }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function handleRemoveSpec() {
    setError(null);
    try {
      await api.deleteActivitySpec(activity.id);
      setEditForm((f) => ({ ...f, specFile: null }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function handleToggleCriterion(index: number) {
    const acceptanceCriteria = activity.acceptanceCriteria.map((c, i) => (i === index ? { ...c, met: !c.met } : c));
    setError(null);
    try {
      await api.updateActivity(activity.id, { acceptanceCriteria });
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function handleDelete() {
    if (!confirm('Excluir esta atividade? A branch criada pra ela não é apagada, só o cadastro aqui.')) return;
    await api.deleteActivity(activity.id);
    await onChanged();
  }

  async function handleStart() {
    setBusy(true);
    setError(null);
    setConcludeResult(null);
    try {
      await api.startActivity(activity.id);
      await Promise.all([onChanged(), onRefreshRunning()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handlePause() {
    setBusy(true);
    setError(null);
    setConcludeResult(null);
    try {
      const { sent } = await api.pauseActivity(activity.id);
      if (!sent) {
        setError('Não encontrei o terminal dessa atividade aberto — pode já ter sido fechado.');
      }
      await onRefreshRunning();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleConclude() {
    setBusy(true);
    setError(null);
    setConcludeResult(null);
    try {
      const result = await api.concludeActivity(activity.id);
      setConcludeResult(result);
      const messages: string[] = [];
      if (!result.terminalClosed) {
        messages.push('MR aberto, mas não consegui fechar o terminal sozinho — feche manualmente.');
      }
      messages.push(...result.warnings);
      if (messages.length > 0) {
        setError(messages.join(' '));
      }
      await Promise.all([onChanged(), onRefreshRunning()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleAddStep() {
    const title = newStepTitle.trim();
    if (!title || savingStep) return;
    setError(null);
    setSavingStep(true);
    try {
      const { steps } = await api.addActivityStep(activity.id, title, newStepFiles);
      onStepsChange(steps);
      setNewStepTitle('');
      setNewStepFiles([]);
      setAddingStep(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSavingStep(false);
    }
  }

  async function handleAddBlock() {
    const title = newBlockTitle.trim();
    if (!title || savingBlock) return;
    setError(null);
    setPendingBlockNotify(null);
    setSavingBlock(true);
    try {
      const { steps, sent, needsConfirmation, blockId } = await api.addActivityBlock(
        activity.id,
        title,
        newBlockDependsOn,
        newBlockSpecFile ?? undefined,
      );
      onStepsChange(steps);
      setNewBlockTitle('');
      setNewBlockDependsOn([]);
      setNewBlockSpecFile(null);
      setAddingBlock(false);
      if (needsConfirmation) {
        setPendingBlockNotify({ id: blockId, title });
        setError(
          'Bloco criado, mas o Claude parece estar trabalhando ativamente agora — o aviso não foi mandado pra não arriscar interromper esse turno.',
        );
      } else if (!sent) {
        setError('Bloco adicionado, mas não encontrei o terminal aberto agora — o Claude vai ver isso na próxima retomada.');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSavingBlock(false);
    }
  }

  async function handleNotifyBlock() {
    if (!pendingBlockNotify || notifyingBlock) return;
    setNotifyingBlock(true);
    setError(null);
    try {
      const { sent } = await api.notifyActivityBlock(activity.id, pendingBlockNotify.id);
      setPendingBlockNotify(null);
      if (!sent) {
        setError('Não encontrei o terminal aberto agora — o Claude vai ver o bloco novo na próxima retomada.');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setNotifyingBlock(false);
    }
  }

  async function handleDeleteStep(title: string) {
    setError(null);
    try {
      const { steps } = await api.deleteActivityStep(activity.id, title);
      onStepsChange(steps);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function handleDeleteBlock(blockId: string, title: string) {
    if (!confirm(`Excluir o bloco "${title}"? Isso também remove as subtasks dele e tira essa dependência de outros blocos.`)) return;
    setError(null);
    try {
      const { steps } = await api.deleteActivityBlock(activity.id, blockId);
      onStepsChange(steps);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  // Subtask amarrado a um bloco específico (modo blocos) via `parentId` —
  // mesmo endpoint de sempre, só passando qual bloco é o dono. Deixa o
  // painel de detalhe do bloco (ver ActivityBlockGraph) tratar como o card
  // de atividade trata seu próprio checklist "solto".
  async function handleAddBlockSubtask(blockId: string, title: string, files: File[]) {
    const trimmed = title.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const { steps } = await api.addActivityStep(activity.id, trimmed, files, blockId);
      onStepsChange(steps);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      throw err;
    }
  }

  async function handleValidateStep(stepId: string) {
    setValidatingStepId(stepId);
    setError(null);
    try {
      const { steps } = await api.validateActivityStep(activity.id, stepId);
      onStepsChange(steps);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setValidatingStepId(null);
    }
  }

  async function handleReleaseStep(stepId: string) {
    const confirm = confirmReleaseStepId === stepId;
    setReleasingStepId(stepId);
    setError(null);
    setReleaseFeedback(null);
    try {
      const { steps, sent, needsConfirmation } = await api.releaseActivityStep(activity.id, stepId, confirm);
      onStepsChange(steps);
      if (needsConfirmation) {
        setConfirmReleaseStepId(stepId);
        setError(
          'O Claude parece estar trabalhando ativamente agora (em outro bloco) — liberar pode interromper esse turno no meio. Clique em "Liberar próxima etapa" de novo pra confirmar mesmo assim.',
        );
      } else {
        setConfirmReleaseStepId(null);
        if (sent) {
          setReleaseFeedback('Liberado! O Claude vai ver o aviso e seguir pro(s) próximo(s) bloco(s) liberado(s).');
        } else {
          setError('Próxima etapa liberada, mas não encontrei o terminal aberto agora — o Claude vai ver isso na próxima retomada.');
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setConfirmReleaseStepId(null);
    } finally {
      setReleasingStepId(null);
    }
  }

  if (editing) {
    return (
      <li className="activity-item activity-form">
        <label className="field">
          Título
          <input value={editForm.title} onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))} />
        </label>
        <label className="field">
          Prompt {!activity.started && '(opcional se anexar uma spec abaixo)'}
          <MentionTextarea
            rows={3}
            value={editForm.prompt}
            onChange={(prompt) => setEditForm((f) => ({ ...f, prompt }))}
            candidates={otherProjects}
            onImageFiles={(files) => setEditForm((f) => ({ ...f, pendingFiles: [...f.pendingFiles, ...files] }))}
          />
          <span className="field-hint">Digite @ pra citar outro projeto que também precisa mudar. Cole ou arraste uma imagem pra anexar.</span>
          <AttachmentPicker
            existing={editForm.attachments}
            pendingFiles={editForm.pendingFiles}
            onAddFiles={(files) => setEditForm((f) => ({ ...f, pendingFiles: [...f.pendingFiles, ...files] }))}
            onRemovePending={(index) => setEditForm((f) => ({ ...f, pendingFiles: f.pendingFiles.filter((_, i) => i !== index) }))}
            onRemoveExisting={(path) => handleRemoveAttachment(path)}
          />
        </label>
        {!activity.started && (
          <label className="field">
            Spec grande (opcional)
            <SpecPicker
              existing={editForm.specFile}
              pendingFile={editForm.pendingSpecFile}
              onPick={(file) => setEditForm((f) => ({ ...f, pendingSpecFile: file }))}
              onRemovePending={() => setEditForm((f) => ({ ...f, pendingSpecFile: null }))}
              onRemoveExisting={() => handleRemoveSpec()}
            />
            <span className="field-hint">
              Anexe um .md com várias telas/etapas e o Claude quebra sozinho em blocos interligados,
              esperando sua validação entre um e outro.
            </span>
          </label>
        )}
        <label className="field">
          Critérios de aceite (opcional)
          <AcceptanceCriteriaEditor
            items={editForm.acceptanceCriteria}
            onChange={(acceptanceCriteria) => setEditForm((f) => ({ ...f, acceptanceCriteria }))}
          />
          <span className="field-hint">
            O "pronto" fixado da tarefa — diferente do checklist de passos, só você marca cada um como
            atendido, e "Concluir atividade" só libera quando todos estiverem.
          </span>
        </label>
        {!activity.started && (
          <>
            <StartOriginChoice
              value={editForm.startFromDevBranch}
              onChange={(startFromDevBranch) => setEditForm((f) => ({ ...f, startFromDevBranch }))}
              devBranch={devBranch}
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
            <RelatedOriginChoice
              value={editForm.relatedStartFromDevBranch}
              onChange={(relatedStartFromDevBranch) => setEditForm((f) => ({ ...f, relatedStartFromDevBranch }))}
              relatedNames={extractMentionedProjectIds(editForm.prompt, otherProjects)
                .map((id) => projectsById.get(id)?.name)
                .filter(Boolean) as string[]}
            />
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => setEditing(false)}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" onClick={handleSaveEdit}>
            Salvar
          </button>
        </div>
      </li>
    );
  }

  const relatedNames = activity.relatedProjectIds.map((id) => projectsById.get(id)?.name).filter(Boolean) as string[];

  // "started" só marca que já rodou uma vez — não diz se tá rodando agora.
  // O rótulo/estado real cruza os dois: sem isso, dava pra mostrar
  // "Continuar" (desabilitado) ao mesmo tempo que a bolinha dizia
  // "rodando", o que é contraditório e confuso.
  const startLabel = !activity.started ? 'Iniciar' : running ? 'Em andamento' : 'Continuar';
  const statusLabel = running ? 'rodando agora' : activity.started ? 'pausada — terminal fechado' : null;
  // Origem só é relevante mostrar antes da primeira vez que a atividade
  // roda (depois disso já tem sua própria branch com histórico próprio,
  // decidida lá atrás).
  const originLabel = !activity.started
    ? activity.startFromDevBranch
      ? `branch ${activity.branchName}, a partir de ${devBranch ?? '?'} (com pull)`
      : 'vai continuar na branch atual do projeto (sem criar branch nova)'
    : `branch: ${activity.branchName}`;
  // Branch de desenvolvimento é obrigatória pra iniciar/retomar qualquer
  // atividade — sem isso o app não sabe de onde a atividade deveria partir.
  const startDisabled = !hasFolders || busy || running || !devBranch;
  const allStepsDone = steps.length > 0 && steps.every((s) => s.status === 'done');
  // Passos com `id` são blocos — "done" é só o que o Claude acha, falta a
  // confirmação minha (`validated`) antes de poder concluir.
  const allBlocksValidated = steps.filter((s) => s.id).every((s) => s.validated);
  const allCriteriaMet = activity.acceptanceCriteria.every((c) => c.met);
  const canConclude = activity.started && allStepsDone && allBlocksValidated && allCriteriaMet;
  const concludeDisabledReason = !activity.started
    ? 'Inicie a atividade antes de concluir.'
    : !allStepsDone
      ? 'Ainda há passos pendentes no checklist.'
      : !allBlocksValidated
        ? 'Ainda há blocos concluídos que você não aprovou.'
        : !allCriteriaMet
          ? 'Ainda há critérios de aceite não confirmados.'
          : 'Abre (ou reaproveita) um MR no GitLab e fecha o terminal — checklist de passos concluído e critérios de aceite confirmados';
  const blockSteps = steps.filter((s) => s.id);
  // Último bloco já concluído (por ordem no array, sem timestamp real de
  // conclusão) — o backend já força essa dependência em qualquer bloco
  // novo (ver add_activity_block), isso aqui é só pra mostrar certo no
  // formulário: marcado e travado, não uma sugestão que dá pra desmarcar.
  const lastDoneBlockId = [...blockSteps].reverse().find((b) => b.status === 'done')?.id ?? null;
  // Subtasks amarrados a um bloco (parentId) aparecem no painel de detalhe
  // daquele bloco no diagrama, não aqui — só sobra pro checklist "solto" o
  // que não pertence a nenhum bloco específico.
  const blockSubtasks = steps.filter((s) => !s.id && s.parentId);
  const plainSteps = steps.filter((s) => !s.id && !s.parentId);

  return (
    <li className="activity-item">
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
        {needsAttention && (
          <span
            className="activity-status activity-status-attention"
            title="O terminal parece parado esperando você — pode ter feito uma pergunta ou terminado o turno. Melhor esforço: baseado no texto da tela, pode errar."
          >
            precisa de você
          </span>
        )}
        {activity.concluded && activity.mrUrl && (
          <a className="activity-status activity-status-concluded" href={activity.mrUrl} target="_blank" rel="noreferrer">
            Concluída — ver MR
          </a>
        )}
        {activity.concluded &&
          Object.entries(activity.relatedMrUrls ?? {}).map(([relatedId, url]) => (
            <a key={relatedId} className="activity-status activity-status-concluded" href={url} target="_blank" rel="noreferrer">
              MR: {projectsById.get(relatedId)?.name ?? relatedId}
            </a>
          ))}
      </div>
      {error && <p className="pending-note field-error">{error}</p>}
      {pendingBlockNotify && (
        <p className="pending-note field-error activity-block-notify-retry">
          <button type="button" className="btn" disabled={notifyingBlock} onClick={handleNotifyBlock}>
            {notifyingBlock ? '…' : `Mandar aviso do bloco "${pendingBlockNotify.title}" mesmo assim`}
          </button>
        </p>
      )}
      {releaseFeedback && <p className="pending-note field-success">{releaseFeedback}</p>}
      {concludeResult && (
        <p className="pending-note field-success">
          {concludeResult.created ? 'MR aberto' : 'MR já existente reaproveitado'}:{' '}
          <a href={concludeResult.mrUrl} target="_blank" rel="noreferrer">
            {concludeResult.mrUrl}
          </a>
          {concludeResult.relatedMrs.map((m) => (
            <span key={m.projectId}>
              {' · '}
              <a href={m.mrUrl} target="_blank" rel="noreferrer">
                {m.projectName}
              </a>
            </span>
          ))}
        </p>
      )}
      {summary && (
        <div className="activity-summary">
          <span className="activity-summary-label">Resumo (Claude)</span>
          <p>{summary}</p>
        </div>
      )}
      <ActivityDiffSummaryBox files={diffFiles} loading={loadingDiff} onRefresh={refreshDiffSummary} />
      <p className="activity-prompt">{activity.prompt}</p>
      <ReadOnlyAttachments paths={activity.attachments} />
      <AcceptanceCriteriaList criteria={activity.acceptanceCriteria} onToggle={handleToggleCriterion} />
      {activity.started && (
        <>
          {blockSteps.length > 0 && (
            <div className="activity-block-graph-wrap">
              {onOpenGraph && (
                <button
                  type="button"
                  className="btn activity-block-graph-expand"
                  title="Abrir diagrama em outra aba"
                  onClick={() => onOpenGraph(activity)}
                >
                  <FiMaximize2 size={14} />
                </button>
              )}
              <ActivityBlockGraph
                steps={blockSteps}
                subtasks={blockSubtasks}
                busyStepId={validatingStepId}
                onValidate={handleValidateStep}
                releasingStepId={releasingStepId}
                confirmReleaseStepId={confirmReleaseStepId}
                onRelease={handleReleaseStep}
                onAddSubtask={handleAddBlockSubtask}
                onDeleteSubtask={handleDeleteStep}
                onDeleteBlock={handleDeleteBlock}
              />
            </div>
          )}
          {(plainSteps.length > 0 || blockSteps.length === 0) && (
            <ActivityProgressList steps={plainSteps} onDeleteStep={handleDeleteStep} />
          )}
        </>
      )}
      {activity.started && addingStep && (
        <div className="activity-add-step">
          <input
            autoFocus
            value={newStepTitle}
            disabled={savingStep}
            onChange={(e) => setNewStepTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddStep();
              if (e.key === 'Escape' && !savingStep) {
                setAddingStep(false);
                setNewStepTitle('');
              }
            }}
            placeholder="O que falta ajustar?"
          />
          <AttachmentPicker
            existing={[]}
            pendingFiles={newStepFiles}
            onAddFiles={(files) => setNewStepFiles((prev) => [...prev, ...files])}
            onRemovePending={(index) => setNewStepFiles((prev) => prev.filter((_, i) => i !== index))}
          />
          <button type="button" className="btn btn-primary" disabled={savingStep} onClick={handleAddStep}>
            {savingStep ? 'Salvando…' : 'Adicionar'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={savingStep}
            onClick={() => {
              setAddingStep(false);
              setNewStepTitle('');
              setNewStepFiles([]);
            }}
          >
            Cancelar
          </button>
        </div>
      )}
      {activity.started && addingBlock && (
        <div className="activity-add-step activity-add-block">
          <input
            autoFocus
            value={newBlockTitle}
            disabled={savingBlock}
            onChange={(e) => setNewBlockTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !savingBlock) {
                setAddingBlock(false);
                setNewBlockTitle('');
                setNewBlockDependsOn([]);
                setNewBlockSpecFile(null);
              }
            }}
            placeholder="Título do bloco novo (ex: um pedido extra depois que tudo terminou)"
          />
          {blockSteps.length > 0 && (
            <div className="activity-add-block-deps">
              <span className="field-hint">
                Depende de {lastDoneBlockId ? '(o último bloco concluído é sempre incluído automaticamente)' : '(opcional)'}:
              </span>
              {blockSteps.map((b) => {
                const isLastDone = b.id === lastDoneBlockId;
                return (
                  <label key={b.id} className="activity-add-block-dep">
                    <input
                      type="checkbox"
                      checked={isLastDone || newBlockDependsOn.includes(b.id!)}
                      disabled={isLastDone}
                      title={isLastDone ? 'Sempre incluído: bloco novo nunca fica sem depender do último concluído' : undefined}
                      onChange={(e) =>
                        setNewBlockDependsOn((prev) =>
                          e.target.checked ? [...prev, b.id!] : prev.filter((id) => id !== b.id),
                        )
                      }
                    />
                    {b.title}
                  </label>
                );
              })}
            </div>
          )}
          <SpecPicker
            existing={null}
            pendingFile={newBlockSpecFile}
            onPick={setNewBlockSpecFile}
            onRemovePending={() => setNewBlockSpecFile(null)}
          />
          <span className="field-hint">
            Opcional: anexe um .md com o escopo específico deste bloco (ex: um documento novo de endpoints).
            O Claude lê esse arquivo antes de trabalhar nele.
          </span>
          <button type="button" className="btn btn-primary" disabled={savingBlock} onClick={handleAddBlock}>
            {savingBlock ? 'Salvando…' : 'Adicionar bloco'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={savingBlock}
            onClick={() => {
              setAddingBlock(false);
              setNewBlockTitle('');
              setNewBlockDependsOn([]);
              setNewBlockSpecFile(null);
            }}
          >
            Cancelar
          </button>
        </div>
      )}
      {relatedNames.length > 0 && <p className="pending-note activity-related">Também mexe em: {relatedNames.join(', ')}</p>}
      {originLabel && <p className="pending-note activity-related">{originLabel}</p>}
      <div className="activity-actions">
        <button
          type="button"
          className="btn"
          disabled={startDisabled}
          title={!devBranch ? 'Configure a branch de desenvolvimento do projeto primeiro' : undefined}
          onClick={handleStart}
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
          onClick={handlePause}
        >
          Pausar
        </button>
        <button
          type="button"
          className="btn btn-success"
          disabled={!canConclude || busy}
          title={concludeDisabledReason}
          onClick={handleConclude}
        >
          {busy ? '…' : 'Concluir atividade'}
        </button>
        {activity.started && !addingStep && (
          <button
            type="button"
            className="btn"
            title="Registra um ajuste pendente no checklist — o 'Continuar' avisa o Claude sobre isso"
            onClick={() => {
              setAddingStep(true);
              setNewStepTitle('');
            }}
          >
            + Subtask
          </button>
        )}
        {activity.started && !!activity.specFile && !addingBlock && (
          <button
            type="button"
            className="btn"
            title="Adiciona um bloco novo ao diagrama (com dependências próprias) — útil pra um pedido extra depois que os blocos originais terminaram"
            onClick={() => {
              setAddingBlock(true);
              setNewBlockTitle('');
              setNewBlockDependsOn([]);
              setNewBlockSpecFile(null);
            }}
          >
            + Bloco
          </button>
        )}
        <button type="button" className="btn" onClick={startEditing}>
          Editar
        </button>
        <button type="button" className="btn btn-danger" onClick={handleDelete}>
          Excluir
        </button>
      </div>
    </li>
  );
}
