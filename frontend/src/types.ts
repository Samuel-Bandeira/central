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
}

export interface ProjectInput {
  name: string;
  folders: Folder[];
  trelloBoardUrl?: string | null;
  runCommand?: string | null;
  devBranch?: string | null;
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
}

export interface Activity {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  started: boolean;
  relatedProjectIds: string[];
  startFromDevBranch: boolean;
  branchName: string;
}

export interface ActivityInput {
  title: string;
  prompt: string;
  relatedProjectIds: string[];
  startFromDevBranch: boolean;
  branchName: string;
}

export interface RunningActivities {
  activityIds: string[];
}

export type ActivityStepStatus = 'pending' | 'in_progress' | 'done';

export interface ActivityStep {
  title: string;
  status: ActivityStepStatus;
}

export interface ActivityProgress {
  steps: ActivityStep[];
}

export interface ActivityStartResult {
  branch: string;
  resuming: boolean;
}
