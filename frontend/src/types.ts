export interface Folder {
  name: string;
  path: string;
}

export interface Project {
  id: string;
  name: string;
  folders: Folder[];
  trelloBoardUrl: string | null;
  trelloBoardId: string | null;
  runCommand: string | null;
  devBranch: string | null;
  prodBranch: string | null;
}

export interface ProjectInput {
  name: string;
  folders: Folder[];
  trelloBoardUrl?: string | null;
  runCommand?: string | null;
  devBranch?: string | null;
  prodBranch?: string | null;
}

export interface SectionPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Section {
  id: string;
  name: string;
  position: SectionPosition;
  projectIds: string[];
}

export interface SectionInput {
  name: string;
  position: SectionPosition;
  projectIds: string[];
}

export interface TrelloSummary {
  integrated: boolean;
  lists: { name: string; cardCount: number }[];
}

export interface TrelloCards {
  integrated: boolean;
  cards: { id: string; name: string; listName: string }[];
}

export interface SectionStartResult {
  started: string[];
  alreadyRunning: string[];
  failed: { projectId: string; error: string }[];
}

export interface SectionStopResult {
  stopped: string[];
  notRunning: string[];
  failed: { projectId: string; error: string }[];
}

export interface RunningProjects {
  projectIds: string[];
  ports: Record<string, number[]>;
}

export interface AcceptanceCriterion {
  text: string;
  met: boolean;
}

export interface Activity {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  acceptanceCriteria: AcceptanceCriterion[];
  attachments: string[];
  // Caminho absoluto do .md de spec anexado (POST/DELETE /activities/{id}/spec).
  // Presente == atividade em "modo blocos": o checklist vira um grafo de
  // dependência em vez de lista plana (ver ActivityBlockGraph).
  specFile: string | null;
  started: boolean;
  concluded: boolean;
  mrUrl: string | null;
  relatedMrUrls: Record<string, string>;
  relatedBranchNames: Record<string, string>;
  relatedProjectIds: string[];
  startFromDevBranch: boolean;
  branchName: string;
  relatedStartFromDevBranch: boolean;
}

export interface ActivityInput {
  title: string;
  prompt: string;
  acceptanceCriteria: AcceptanceCriterion[];
  relatedProjectIds: string[];
  startFromDevBranch: boolean;
  branchName: string;
  relatedStartFromDevBranch: boolean;
}

export interface RunningActivities {
  activityIds: string[];
  needsAttentionIds: string[];
}

export type ActivityStepStatus = 'pending' | 'in_progress' | 'done';

export interface ActivityStep {
  title: string;
  status: ActivityStepStatus;
  source?: 'user' | 'claude';
  attachments?: string[];
  // Campos só presentes em passos que fazem parte de um "bloco" (modo
  // blocos, atividade com specFile) — passos comuns continuam sem eles.
  id?: string;
  dependsOn?: string[];
  // Presente quando este step é uma subtask de um bloco específico (modo
  // blocos) — aponta pro `id` do bloco dono. Some quando o step é o
  // próprio bloco (tem `id`) ou uma subtask "solta" da atividade.
  parentId?: string;
  // Só o humano marca (POST /activities/{id}/steps/{stepId}/validate) — o
  // Claude é instruído a nunca escrever aqui, mesmo espírito de
  // AcceptanceCriterion.met.
  validated?: boolean;
  // Idem, mas setado por POST .../steps/{stepId}/release — precisa
  // persistir (não só refletir na resposta da chamada) senão um refresh
  // da página perde a informação e o botão "Liberar próxima etapa" volta a
  // aparecer clicável num bloco que já foi liberado de verdade.
  released?: boolean;
  // Spec .md própria deste bloco (POST /activities/{id}/blocks, ver
  // add_activity_block) — diferente do specFile da Activity, que cobre a
  // atividade inteira: esse aqui é o escopo específico de UM bloco (ex:
  // um pedido extra criado depois, com um documento novo anexado).
  specFile?: string;
}

export function attachmentUrl(path: string): string {
  return `/attachments/file?path=${encodeURIComponent(path)}`;
}

export interface ActivityProgress {
  steps: ActivityStep[];
  // Visão geral em prosa que o Claude mantém sobre a atividade — o que ela
  // faz e o que esperar ver na UI quando pronta. Sobrevive à fragmentação
  // do checklist em passos/blocos miúdos (ver SUMMARY_FIELD_INSTRUCTION no
  // backend), string vazia até o Claude escrever o primeiro entendimento.
  summary: string;
}

export type ActivityDiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ActivityDiffFile {
  path: string;
  oldPath: string | null;
  status: ActivityDiffFileStatus;
}

// Lista real (via `git diff` no backend, não depende do que o Claude
// lembra/escreve) de arquivos que a atividade criou/mexeu/removeu — ver
// GET /activities/{id}/diff-summary.
export interface ActivityDiffSummary {
  files: ActivityDiffFile[];
}

export interface ActivityStartResult {
  branch: string;
  resuming: boolean;
}

export interface ActivityConcludeResult {
  mrUrl: string;
  created: boolean;
  terminalClosed: boolean;
  relatedMrs: { projectId: string; projectName: string; mrUrl: string; created: boolean }[];
  warnings: string[];
}
