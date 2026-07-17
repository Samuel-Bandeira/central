import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { Project, Section } from '../types';
import { ProjectCard, type ProjectRunStatus } from './ProjectCard';

interface Props {
  section: Section;
  projects: Project[];
  getStatus: (projectId: string) => ProjectRunStatus;
  onOpenDetail: (project: Project) => void;
  onPositionChange: (sectionId: string, position: Section['position']) => void;
  onDropProject: (sectionId: string, projectId: string) => void;
  onRename: (sectionId: string, name: string) => void;
  onDelete: (sectionId: string) => void;
  onRunningChange: () => void;
  onStopped: (projectIds: string[]) => void;
  onToast: (message: string) => void;
}

// Precisa bater com o layout real dos cards em .section-body (index.css):
// width do .project-card, gap entre eles, padding do .section-body e a
// borda de 1px de cada lado do próprio .section-box (2px, antes esquecida).
// CARD_SAFETY_MARGIN é uma folga de propósito por item — evita que qualquer
// diferença de subpixel/arredondamento do layout real deixe a seção estreita
// demais e quebre a disposição dos cards numa linha só.
const CARD_WIDTH = 210;
const CARD_SAFETY_MARGIN = 50;
const EFFECTIVE_CARD_WIDTH = CARD_WIDTH + CARD_SAFETY_MARGIN;
const CARD_GAP = 8;
const BODY_PADDING = 20;
const BOX_BORDER = 2;
const MIN_WIDTH_EMPTY = 220;
const MIN_HEIGHT = 140;

function minWidthForCount(count: number): number {
  if (count === 0) return MIN_WIDTH_EMPTY;
  return count * EFFECTIVE_CARD_WIDTH + (count - 1) * CARD_GAP + BODY_PADDING + BOX_BORDER;
}

function missingRunCommandIds(detail: unknown): string[] | null {
  if (detail && typeof detail === 'object' && 'missingRunCommand' in detail) {
    const ids = (detail as { missingRunCommand: unknown }).missingRunCommand;
    if (Array.isArray(ids)) return ids as string[];
  }
  return null;
}

function formatNameList(names: string[]): string {
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return names.join(' e ');
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
}

function statusToast(names: string[], verbSingular: string, verbPlural: string): string {
  const subject = names.length === 1 ? 'O processo' : 'Os processos';
  const verb = names.length === 1 ? verbSingular : verbPlural;
  return `${subject} ${formatNameList(names)} ${verb}`;
}

export function SectionBox({
  section,
  projects,
  getStatus,
  onOpenDetail,
  onPositionChange,
  onDropProject,
  onRename,
  onDelete,
  onRunningChange,
  onStopped,
  onToast,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [nameDraft, setNameDraft] = useState(section.name);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const sectionProjects = projects.filter((p) => section.projectIds.includes(p.id));
  const hasProjects = section.projectIds.length > 0;
  const minWidth = minWidthForCount(sectionProjects.length);
  const width = Math.max(section.position.width, minWidth);

  // Se o número de projetos cresceu (ex: soltou mais um dentro da seção) e a
  // largura guardada ficou menor que o mínimo necessário, corrige e persiste.
  useEffect(() => {
    if (section.position.width < minWidth) {
      onPositionChange(section.id, { ...section.position, width: minWidth });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minWidth]);

  function startMove(e: React.PointerEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (target.closest('.section-actions, .section-name-input, .project-card')) return;

    const box = boxRef.current;
    if (!box) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = section.position.x;
    const startTop = section.position.y;

    function onMove(ev: PointerEvent) {
      const newX = Math.max(0, startLeft + (ev.clientX - startX));
      const newY = Math.max(0, startTop + (ev.clientY - startY));
      box!.style.left = `${newX}px`;
      box!.style.top = `${newY}px`;
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      onPositionChange(section.id, {
        x: parseFloat(box!.style.left),
        y: parseFloat(box!.style.top),
        width: section.position.width,
        height: section.position.height,
      });
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    const box = boxRef.current;
    if (!box) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = section.position.width;
    const startHeight = section.position.height;

    function onMove(ev: PointerEvent) {
      const newWidth = Math.max(minWidth, startWidth + (ev.clientX - startX));
      const newHeight = Math.max(MIN_HEIGHT, startHeight + (ev.clientY - startY));
      box!.style.width = `${newWidth}px`;
      box!.style.height = `${newHeight}px`;
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      onPositionChange(section.id, {
        x: section.position.x,
        y: section.position.y,
        width: parseFloat(box!.style.width),
        height: parseFloat(box!.style.height),
      });
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function describeFailures(failed: { projectId: string; error: string }[]): string {
    const names = failed.map((f) => projects.find((p) => p.id === f.projectId)?.name ?? f.projectId).join(', ');
    return names;
  }

  async function handleStart() {
    if (!hasProjects || starting) return;
    setStarting(true);
    setFeedback(null);
    try {
      const result = await api.startSection(section.id);
      if (result.alreadyRunning.length) {
        const names = result.alreadyRunning.map((id) => projects.find((p) => p.id === id)?.name ?? id);
        onToast(statusToast(names, 'já está rodando', 'já estão rodando'));
      }
      if (result.failed.length) {
        setFeedback(`Falha ao iniciar: ${describeFailures(result.failed)}`);
      }
      onRunningChange();
    } catch (err) {
      const missing = err instanceof ApiError ? missingRunCommandIds(err.detail) : null;
      if (missing) {
        const names = missing.map((id) => projects.find((p) => p.id === id)?.name ?? id).join(', ');
        setFeedback(`Configure o comando de execução de: ${names}`);
      } else {
        setFeedback(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setStarting(false);
    }
  }

  async function handleStop() {
    if (!hasProjects || stopping) return;

    const alreadyStopping = section.projectIds.filter((id) => getStatus(id) === 'stopping');
    if (alreadyStopping.length) {
      const names = alreadyStopping.map((id) => projects.find((p) => p.id === id)?.name ?? id);
      onToast(statusToast(names, 'já teve a parada solicitada', 'já tiveram a parada solicitada'));
    }

    const remaining = section.projectIds.filter((id) => getStatus(id) !== 'stopping');
    if (remaining.length === 0) return;

    setStopping(true);
    setFeedback(null);
    try {
      const result = await api.stopSection(section.id);
      if (result.notRunning.length) {
        const names = result.notRunning.map((id) => projects.find((p) => p.id === id)?.name ?? id);
        onToast(statusToast(names, 'já estava parado', 'já estavam parados'));
      }
      if (result.failed.length) {
        setFeedback(`Falha ao parar: ${describeFailures(result.failed)}`);
      }
      onStopped(result.stopped);
      onRunningChange();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  }

  return (
    <div
      ref={boxRef}
      className="section-box"
      style={{
        left: section.position.x,
        top: section.position.y,
        width,
        height: section.position.height,
      }}
      onPointerDown={startMove}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const projectId = e.dataTransfer.getData('text/project-id');
        if (projectId) onDropProject(section.id, projectId);
      }}
    >
      <div className="section-header">
        <input
          className="section-name-input"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={() => {
            if (nameDraft.trim() && nameDraft !== section.name) onRename(section.id, nameDraft.trim());
            else setNameDraft(section.name);
          }}
        />
        <div className="section-actions">
          <button
            type="button"
            className="btn"
            disabled={starting}
            aria-disabled={!hasProjects ? 'true' : undefined}
            title={hasProjects ? 'Iniciar todos os projetos desta seção' : 'Adicione projetos à seção primeiro'}
            onClick={handleStart}
          >
            {starting ? '…' : '▶'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={stopping}
            aria-disabled={!hasProjects ? 'true' : undefined}
            title={hasProjects ? 'Parar todos os projetos desta seção' : 'Adicione projetos à seção primeiro'}
            onClick={handleStop}
          >
            {stopping ? '…' : '■'}
          </button>
          <button type="button" className="btn btn-danger" onClick={() => onDelete(section.id)}>
            Excluir
          </button>
        </div>
      </div>
      {feedback && <p className="pending-note section-feedback">{feedback}</p>}
      <div className="section-body">
        {sectionProjects.length === 0 && <p className="pending-note">Arraste um projeto pra cá</p>}
        {sectionProjects.map((p) => (
          <ProjectCard key={p.id} project={p} status={getStatus(p.id)} onOpenDetail={onOpenDetail} />
        ))}
      </div>
      <div className="section-resize-handle" onPointerDown={startResize} />
    </div>
  );
}
