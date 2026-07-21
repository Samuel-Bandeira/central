import { useEffect, useRef, useState } from 'react';
import { FiCheckCircle, FiCircle, FiImage, FiLoader, FiX } from 'react-icons/fi';
import { attachmentUrl } from '../types';
import type { ActivityStep } from '../types';

// Pedaços usados tanto por ActivityCard quanto por ActivityBlockGraph — num
// arquivo à parte pra evitar import circular entre os dois (ActivityCard
// renderiza ActivityBlockGraph, e ActivityBlockGraph precisa desses mesmos
// componentes pro painel de detalhe de um bloco).

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

// Imagens do clipboard (colar) e do arraste (drag&drop) chegam por
// caminhos diferentes do DOM — este helper padroniza os dois em File[],
// filtrando só o que é imagem (o resto do drop pode ser texto, link etc).
export function extractImageFiles(source: DataTransfer | null): File[] {
  if (!source) return [];
  return Array.from(source.files ?? []).filter(isImageFile);
}

// Gera (e revoga ao trocar/desmontar) uma URL de preview local pra cada
// File ainda não enviado — igual ao chat, a miniatura aparece na hora,
// antes de qualquer round-trip com o backend.
function usePendingPreviews(files: File[]): string[] {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const created = files.map((file) => URL.createObjectURL(file));
    setUrls(created);
    return () => created.forEach((url) => URL.revokeObjectURL(url));
  }, [files]);
  return urls;
}

interface AttachmentPickerProps {
  existing: string[];
  pendingFiles: File[];
  onAddFiles: (files: File[]) => void;
  onRemovePending: (index: number) => void;
  onRemoveExisting?: (path: string) => void;
}

// Anexo de imagem no prompt/subtask, com a mesma sensação do chat da
// claude.ai: miniatura na hora (colar, arrastar ou escolher arquivo) com
// botão de remover. `existing` só é preenchido ao editar uma atividade que
// já tinha anexo salvo — na criação, tudo fica em `pendingFiles` até
// Criar/Salvar (a atividade ainda não tem id pra anexar nada antes disso).
export function AttachmentPicker({ existing, pendingFiles, onAddFiles, onRemovePending, onRemoveExisting }: AttachmentPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingUrls = usePendingPreviews(pendingFiles);

  function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).filter(isImageFile);
    if (files.length > 0) onAddFiles(files);
    e.target.value = '';
  }

  return (
    <div className="attachment-picker">
      {(existing.length > 0 || pendingFiles.length > 0) && (
        <div className="attachment-thumbnails">
          {existing.map((path) => (
            <div key={path} className="attachment-thumbnail">
              <img src={attachmentUrl(path)} alt="Anexo" />
              {onRemoveExisting && (
                <button type="button" className="attachment-remove" aria-label="Remover anexo" onClick={() => onRemoveExisting(path)}>
                  <FiX size={12} />
                </button>
              )}
            </div>
          ))}
          {pendingFiles.map((file, i) => (
            <div key={`${file.name}-${i}`} className="attachment-thumbnail attachment-thumbnail-pending">
              {pendingUrls[i] && <img src={pendingUrls[i]} alt={file.name} />}
              <button type="button" className="attachment-remove" aria-label="Remover anexo" onClick={() => onRemovePending(i)}>
                <FiX size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={handlePick} />
      <button type="button" className="btn attachment-picker-btn" onClick={() => inputRef.current?.click()}>
        <FiImage size={14} /> Anexar imagem
      </button>
    </div>
  );
}

// Exibição só-leitura no card da atividade/passo já salvo — clica pra
// abrir em tamanho real numa aba nova.
export function ReadOnlyAttachments({ paths }: { paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <div className="attachment-thumbnails attachment-thumbnails-readonly">
      {paths.map((path) => (
        <a key={path} href={attachmentUrl(path)} target="_blank" rel="noreferrer" className="attachment-thumbnail">
          <img src={attachmentUrl(path)} alt="Anexo" />
        </a>
      ))}
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
// manter um arquivo .claude-activity-status.json no projeto, e o card faz
// poll nesse arquivo e passa os steps como prop — componente sem estado
// próprio (além do toggle de "ver concluídos"), pra uma adição/exclusão
// manual refletir na hora, sem esperar o próximo ciclo de poll. Reusado
// tanto pro checklist "solto" da atividade quanto pelo checklist de
// subtasks de um bloco específico (ver ActivityBlockGraph).
interface ActivityProgressListProps {
  steps: ActivityStep[];
  onDeleteStep?: (title: string) => void;
}

export function ActivityProgressList({ steps, onDeleteStep }: ActivityProgressListProps) {
  const [showDone, setShowDone] = useState(false);

  if (steps.length === 0) return null;

  const pending = steps.filter((s) => s.status !== 'done');
  const done = steps.filter((s) => s.status === 'done');

  function renderStep(step: ActivityStep, i: number) {
    return (
      <li key={i} className={`activity-step activity-step-${step.status}`}>
        {STEP_ICON[step.status] ?? STEP_ICON.pending}
        <div className="activity-step-body">
          <span>{step.title}</span>
          <ReadOnlyAttachments paths={step.attachments ?? []} />
        </div>
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
    );
  }

  return (
    <div className="activity-steps-wrapper">
      {pending.length > 0 && <ul className="activity-steps">{pending.map(renderStep)}</ul>}
      {pending.length === 0 && done.length > 0 && <p className="pending-note">Todos os passos concluídos.</p>}
      {done.length > 0 && (
        <>
          <button type="button" className="activity-steps-toggle" onClick={() => setShowDone((v) => !v)}>
            {showDone ? 'Ocultar concluídos' : `Ver concluídos (${done.length})`}
          </button>
          {showDone && <ul className="activity-steps">{done.map(renderStep)}</ul>}
        </>
      )}
    </div>
  );
}
