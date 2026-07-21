import { useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { FiCheckCircle, FiLoader, FiCircle, FiX } from 'react-icons/fi';
import type { ActivityStep } from '../types';
import { ActivityProgressList, AttachmentPicker } from './activityShared';

// Reaproveitado tanto no fitView inicial (prop `fitView` do ReactFlow)
// quanto no reset ao dar duplo clique no espaço vazio (ver handlePaneDoubleClick)
// — os dois precisam terminar no mesmo enquadramento "visão geral".
const BASE_FIT_VIEW_OPTIONS = { padding: 0.2, maxZoom: 1 };

const COLUMN_WIDTH = 300;
// 130 (não 110) porque agora o nó pode ter uma segunda linha (badges/botão
// de aprovar ou liberar, ver block-node-footer) abaixo do título — sem
// esse espaço extra, dois blocos no mesmo nível (mesma coluna) se
// sobrepunham quando um deles crescia.
const ROW_HEIGHT = 130;

interface Props {
  steps: ActivityStep[];
  // Subtasks amarrados a um bloco (parentId === id do bloco) — cada bloco
  // mostra as suas no painel de detalhe (ver BlockDetailPanel), não no
  // checklist "solto" da atividade.
  subtasks: ActivityStep[];
  onValidate: (stepId: string) => void;
  busyStepId: string | null;
  // "Liberar próxima etapa" — só chamado quando o bloco já foi aprovado E
  // todas as subtasks dele estão concluídas (ver botão em BlockNode). Ação
  // separada de onValidate de propósito: aprovar não avança o Claude
  // sozinho, dá espaço pra pedir subtasks extras antes de liberar.
  onRelease: (stepId: string) => void;
  releasingStepId: string | null;
  onAddSubtask: (blockId: string, title: string, files: File[]) => Promise<void>;
  onDeleteSubtask: (title: string) => void;
}

// Nível de cada bloco = 1 + maior nível das suas dependências (0 se não
// depende de nada) — cobre bem o caso principal (cadeia sequencial, como
// no exemplo do n8n que motivou essa tela) e também funciona se um bloco
// depender de mais de um outro. Sem lib de auto-layout: pra um grafo desse
// tamanho (blocos de uma atividade, não um pipeline gigante) um cálculo
// simples de camadas já resolve.
function computeLevels(steps: ActivityStep[]): Map<string, number> {
  const byId = new Map(steps.map((s) => [s.id ?? s.title, s]));
  const levels = new Map<string, number>();

  function levelOf(id: string, seen: Set<string>): number {
    if (levels.has(id)) return levels.get(id)!;
    if (seen.has(id)) return 0; // dependência circular — melhor esforço, não trava a UI
    seen.add(id);
    const step = byId.get(id);
    const deps = step?.dependsOn ?? [];
    const level = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => levelOf(d, seen)));
    levels.set(id, level);
    return level;
  }

  for (const step of steps) {
    levelOf(step.id ?? step.title, new Set());
  }
  return levels;
}

const STATUS_ICON: Record<string, React.ReactNode> = {
  done: <FiCheckCircle className="block-node-icon block-node-icon-done" />,
  in_progress: <FiLoader className="block-node-icon block-node-icon-in-progress" />,
  pending: <FiCircle className="block-node-icon block-node-icon-pending" />,
};

interface BlockNodeData extends Record<string, unknown> {
  step: ActivityStep;
  onValidate: (stepId: string) => void;
  onRelease: (stepId: string) => void;
  busy: boolean;
  releasing: boolean;
  released: boolean;
  selected: boolean;
  subtaskCount: { done: number; total: number } | null;
}

function BlockNode({ data }: { data: BlockNodeData }) {
  const { step, onValidate, onRelease, busy, releasing, released, selected, subtaskCount } = data;
  const stepId = step.id ?? step.title;
  const canValidate = step.status === 'done' && !step.validated;
  const subtasksPending = subtaskCount !== null && subtaskCount.done < subtaskCount.total;
  const canRelease = step.status === 'done' && !!step.validated && !released && !subtasksPending;

  // Botões de fluxo (Aprovar/Liberar) ficam sempre visíveis, só desabilitados
  // fora de hora — sumir o botão inteiro escondia a próxima ação possível,
  // dava a impressão de que a atividade tinha travado em vez de só estar
  // esperando uma etapa anterior.
  const validateTitle = step.validated
    ? 'Este bloco já foi aprovado.'
    : step.status !== 'done'
      ? 'Aguardando o Claude marcar este bloco como concluído.'
      : undefined;
  const releaseTitle = released
    ? 'Próxima etapa já liberada.'
    : !step.validated
      ? 'Aprove este bloco antes de liberar a próxima etapa.'
      : subtasksPending
        ? 'Resolva as subtasks pendentes deste bloco antes de liberar a próxima etapa.'
        : 'Avisa o Claude que pode seguir pro(s) próximo(s) bloco(s) liberado(s)';

  return (
    <div
      className={`block-node block-node-${step.status} ${step.validated ? 'block-node-validated' : ''} ${selected ? 'block-node-selected' : ''}`}
    >
      <div className="block-node-main">
        <Handle type="target" position={Position.Left} />
        {STATUS_ICON[step.status] ?? STATUS_ICON.pending}
        <div className="block-node-body">
          <span className="block-node-title">{step.title}</span>
          {subtaskCount && (
            <span className="block-node-subtask-count">
              {subtaskCount.done}/{subtaskCount.total} subtasks
            </span>
          )}
        </div>
        <Handle type="source" position={Position.Right} />
      </div>
      <div className="block-node-footer">
        {step.validated && <span className="block-node-validated-badge">aprovado</span>}
        {released && <span className="block-node-validated-badge">próxima etapa liberada</span>}
        <button
          type="button"
          className="btn btn-primary block-node-validate"
          disabled={!canValidate || busy}
          title={validateTitle}
          onClick={(e) => {
            e.stopPropagation();
            onValidate(stepId);
          }}
        >
          {busy ? '…' : 'Aprovar'}
        </button>
        <button
          type="button"
          className="btn btn-primary block-node-validate"
          disabled={!canRelease || releasing}
          title={releaseTitle}
          onClick={(e) => {
            e.stopPropagation();
            onRelease(stepId);
          }}
        >
          {releasing ? '…' : 'Liberar próxima etapa'}
        </button>
      </div>
    </div>
  );
}

const NODE_TYPES = { block: BlockNode };

// Uma dependência direta do bloco selecionado, com o "pronto" já resolvido
// (mesma condição que libera o botão individual no próprio bloco dela —
// ver canRelease em BlockNode) pra render no painel de detalhe.
interface DependencyStatus {
  id: string;
  title: string;
  ready: boolean;
}

interface BlockDetailPanelProps {
  block: ActivityStep;
  dependencies: DependencyStatus[];
  subtasks: ActivityStep[];
  onAddSubtask: (blockId: string, title: string, files: File[]) => Promise<void>;
  onDeleteSubtask: (title: string) => void;
  onClose: () => void;
  // Só presente quando o bloco tem mais de uma dependência direta (fan-in,
  // ex: um bloco final que só começa depois de 3 outros) — junta as N
  // liberações individuais (uma por dependência) num botão só aqui no
  // painel do bloco que efetivamente vai se beneficiar disso, em vez de
  // tentar desenhar uma caixa ao redor delas no canvas (não escala: numa
  // spec grande as dependências de um mesmo bloco raramente caem juntas
  // numa coluna só, e a caixa acabava atravessando o diagrama inteiro).
  onReleaseGroup: (() => void) | null;
  releasingGroup: boolean;
}

// Painel de detalhe de UM bloco selecionado no diagrama — é o que faz cada
// nó parar de ser "só uma caixa com texto": mostra a checklist de subtasks
// daquele bloco especificamente (as que o Claude for detalhando enquanto
// trabalha nele, ou que eu adicionar aqui manualmente) e deixa adicionar
// mais. Fica ao lado do canvas em vez de crescer o nó — evita reorganizar
// o layout (posições dos nós são fixas, calculadas por `computeLevels`) só
// porque um bloco tem uma checklist mais longa que outro.
function BlockDetailPanel({
  block,
  dependencies,
  subtasks,
  onAddSubtask,
  onDeleteSubtask,
  onClose,
  onReleaseGroup,
  releasingGroup,
}: BlockDetailPanelProps) {
  const [newTitle, setNewTitle] = useState('');
  const [newFiles, setNewFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);

  async function handleAdd() {
    const title = newTitle.trim();
    if (!title || saving) return;
    setSaving(true);
    try {
      await onAddSubtask(block.id ?? block.title, title, newFiles);
      setNewTitle('');
      setNewFiles([]);
    } catch {
      // erro já reportado pelo card da atividade — mantém o form aberto pra tentar de novo
    } finally {
      setSaving(false);
    }
  }

  const allDepsReady = dependencies.length > 0 && dependencies.every((d) => d.ready);

  return (
    <div className="activity-block-detail">
      <div className="activity-block-detail-header">
        <strong>{block.title}</strong>
        <button type="button" className="btn btn-icon" aria-label="Fechar detalhe do bloco" onClick={onClose}>
          <FiX size={14} />
        </button>
      </div>
      {dependencies.length > 0 && (
        <div className="activity-block-dependencies">
          <p className="pending-note">Depende de:</p>
          <ul className="activity-block-dependencies-list">
            {dependencies.map((d) => (
              <li key={d.id} className={d.ready ? 'activity-block-dependency-ready' : ''}>
                {d.ready ? <FiCheckCircle size={13} /> : <FiCircle size={13} />}
                {d.title}
              </li>
            ))}
          </ul>
          {onReleaseGroup && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!allDepsReady || releasingGroup}
              title={
                allDepsReady
                  ? 'Avisa o Claude que pode seguir pra este bloco'
                  : 'Aprove e resolva as subtasks de todas as dependências acima antes de liberar.'
              }
              onClick={onReleaseGroup}
            >
              {releasingGroup ? '…' : 'Liberar dependências'}
            </button>
          )}
        </div>
      )}
      {subtasks.length > 0 ? (
        <ActivityProgressList steps={subtasks} onDeleteStep={onDeleteSubtask} />
      ) : (
        <p className="pending-note">Nenhuma subtask neste bloco ainda.</p>
      )}
      <div className="activity-add-step">
        <input
          value={newTitle}
          disabled={saving}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder="Nova subtask deste bloco"
        />
        <AttachmentPicker
          existing={[]}
          pendingFiles={newFiles}
          onAddFiles={(files) => setNewFiles((prev) => [...prev, ...files])}
          onRemovePending={(index) => setNewFiles((prev) => prev.filter((_, i) => i !== index))}
        />
        <button type="button" className="btn btn-primary" disabled={saving} onClick={handleAdd}>
          {saving ? 'Salvando…' : '+ Subtask'}
        </button>
      </div>
    </div>
  );
}

// Grafo de blocos de uma "task grande" (atividade com spec .md anexada) —
// substitui o checklist plano quando os passos carregam `dependsOn`. Só
// libera "Validar" pra blocos que o Claude já marcou "done"; a instrução de
// modo blocos (backend) trava o avanço até esse campo virar true. Clicar
// num bloco abre o painel de detalhe dele (ver BlockDetailPanel) — o
// terminal Claude continua único pra atividade inteira (não dá pra
// pausar/retomar um bloco isolado), mas cada bloco tem sua própria
// checklist de subtasks, igual um mini card de atividade.
export function ActivityBlockGraph({
  steps,
  subtasks,
  onValidate,
  busyStepId,
  onRelease,
  releasingStepId,
  onAddSubtask,
  onDeleteSubtask,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Instância crua do React Flow (via onInit) em vez do hook useReactFlow —
  // esse componente é quem RENDERIZA o <ReactFlow>, não um filho dele, então
  // não tem o Provider do hook no contexto. Usada só pra centralizar/dar
  // zoom num bloco (ver handleNodeClick).
  const reactFlowInstanceRef = useRef<ReactFlowInstance<Node<BlockNodeData>> | null>(null);

  function handleNodeClick(_: React.MouseEvent, node: Node<BlockNodeData>) {
    setSelectedId(node.id);
    // Selecionar o bloco abre o BlockDetailPanel ao lado, o que encolhe a
    // largura do canvas — se o fitView rodasse já aqui (síncrono com o
    // setState), ele calcularia o zoom com base no canvas ainda LARGO (de
    // antes do painel aparecer), e o resultado saía sub-zoomado assim que o
    // painel entrava (só "recentralizava" visualmente, sem dar zoom de
    // verdade). Dois requestAnimationFrame esperam o painel renderizar e o
    // ResizeObserver do React Flow captar a nova largura antes de calcular.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        reactFlowInstanceRef.current?.fitView({ nodes: [{ id: node.id }], duration: 400, padding: 0.5, maxZoom: 1.5 });
      });
    });
  }

  // Duplo clique no espaço vazio do canvas (fora de qualquer nó) volta pro
  // enquadramento inicial — mesmo raciocínio do double-rAF acima: fecha o
  // BlockDetailPanel (que alarga o canvas de volta) antes de recalcular o
  // fitView, senão o zoom sai errado com base na largura ainda estreita.
  function handlePaneDoubleClick() {
    setSelectedId(null);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        reactFlowInstanceRef.current?.fitView({ duration: 400, ...BASE_FIT_VIEW_OPTIONS });
      });
    });
  }

  // Confirmação visual de que a liberação foi enviada — só local/efêmera
  // (não persiste no backend, some ao trocar de aba/recarregar): o próprio
  // `validated` continua true depois, não teria como distinguir "ainda não
  // liberei" de "já liberei" sem isso, e reenviar o aviso de novo não é
  // destrutivo, só redundante.
  const [releasedIds, setReleasedIds] = useState<Set<string>>(new Set());

  function handleRelease(stepId: string) {
    onRelease(stepId);
    setReleasedIds((prev) => new Set(prev).add(stepId));
  }

  const subtasksByBlock = useMemo(() => {
    const map = new Map<string, ActivityStep[]>();
    for (const s of subtasks) {
      if (!s.parentId) continue;
      const list = map.get(s.parentId) ?? [];
      list.push(s);
      map.set(s.parentId, list);
    }
    return map;
  }, [subtasks]);

  const { nodes, edges } = useMemo(() => {
    const levels = computeLevels(steps);
    const countByLevel = new Map<number, number>();
    const builtNodes: Node<BlockNodeData>[] = steps.map((step) => {
      const stepId = step.id ?? step.title;
      const level = levels.get(stepId) ?? 0;
      const row = countByLevel.get(level) ?? 0;
      countByLevel.set(level, row + 1);
      const blockSubtasks = subtasksByBlock.get(stepId) ?? [];
      return {
        id: stepId,
        type: 'block',
        position: { x: level * COLUMN_WIDTH, y: row * ROW_HEIGHT },
        data: {
          step,
          onValidate,
          onRelease: handleRelease,
          busy: busyStepId === stepId,
          releasing: releasingStepId === stepId,
          released: releasedIds.has(stepId),
          selected: stepId === selectedId,
          subtaskCount:
            blockSubtasks.length > 0
              ? { done: blockSubtasks.filter((s) => s.status === 'done').length, total: blockSubtasks.length }
              : null,
        },
        draggable: true,
      };
    });
    const builtEdges: Edge[] = steps.flatMap((step) =>
      (step.dependsOn ?? []).map((depId) => ({
        id: `${depId}->${step.id ?? step.title}`,
        source: depId,
        target: step.id ?? step.title,
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    );
    return { nodes: builtNodes, edges: builtEdges };
  }, [steps, onValidate, handleRelease, busyStepId, releasingStepId, releasedIds, selectedId, subtasksByBlock]);

  const selectedBlock = steps.find((s) => (s.id ?? s.title) === selectedId) ?? null;
  // "Pronto" de cada dependência = mesma condição que libera o botão
  // individual dela (canRelease em BlockNode): aprovada e sem subtasks
  // pendentes. Repetido aqui (em vez de reaproveitar canRelease) porque lá
  // é calculado dentro do próprio nó, sem acesso direto às outras
  // dependências do bloco selecionado.
  const dependencies: DependencyStatus[] = (selectedBlock?.dependsOn ?? []).map((depId) => {
    const dep = steps.find((s) => (s.id ?? s.title) === depId);
    const depSubtasks = subtasksByBlock.get(depId) ?? [];
    const ready = !!dep && dep.status === 'done' && !!dep.validated && depSubtasks.every((s) => s.status === 'done');
    return { id: depId, title: dep?.title ?? depId, ready };
  });
  // Só faz sentido juntar num botão só quando há mais de uma dependência
  // direta (fan-in) — com uma só, o botão individual dela já resolve.
  const onReleaseGroup = dependencies.length > 1 ? () => handleRelease(dependencies[0].id) : null;
  const releasingGroup = dependencies.length > 1 && dependencies.some((d) => d.id === releasingStepId);

  return (
    <div className="activity-block-graph">
      <div
        className="activity-block-graph-canvas"
        // ReactFlow não expõe onPaneDoubleClick — detecta na unha checando
        // se o alvo do duplo clique é o próprio fundo do canvas (não um nó).
        // zoomOnDoubleClick={false} abaixo desliga o zoom-in nativo do
        // React Flow nesse mesmo clique, que senão brigava com este reset.
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).classList.contains('react-flow__pane')) handlePaneDoubleClick();
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={BASE_FIT_VIEW_OPTIONS}
          minZoom={0.2}
          zoomOnDoubleClick={false}
          onInit={(instance) => {
            reactFlowInstanceRef.current = instance;
          }}
          onNodeClick={handleNodeClick}
          onPaneClick={() => setSelectedId(null)}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {selectedBlock && (
        <BlockDetailPanel
          block={selectedBlock}
          dependencies={dependencies}
          subtasks={subtasksByBlock.get(selectedId!) ?? []}
          onAddSubtask={onAddSubtask}
          onDeleteSubtask={onDeleteSubtask}
          onClose={() => setSelectedId(null)}
          onReleaseGroup={onReleaseGroup}
          releasingGroup={releasingGroup}
        />
      )}
    </div>
  );
}
