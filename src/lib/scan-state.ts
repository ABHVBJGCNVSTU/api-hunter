// API HUNTER - In-memory scan state (singleton, survives HMR)
// NOTE: the GitHub token is mirrored into the DB Setting vault at operator's
// request so the 24/7 chain survives restarts; it is never returned by any API.

export type LogLevel = "SYS" | "INFO" | "OK" | "WARN" | "ERR";
export type ScanStatus = "idle" | "running" | "stopping";

export interface LogLine {
  i: number; // sequence index
  t: number; // timestamp
  l: LogLevel;
  m: string;
}

export interface ScanConfig {
  preset: string;
  language: string; // "javascript" | "any"
  hoursBack: number;
  maxRepos: number;
  autoCheck: boolean;
  depth: string; // quick | deep | ultra
}

export interface ScanProgress {
  status: ScanStatus;
  config: ScanConfig | null;
  startedAt: number | null;
  finishedAt: number | null;
  reposQueued: number;
  reposDone: number;
  reposSkipped: number; // repos skipped: no new code since last scan (watch mode)
  currentRepo: string | null;
  currentFile: string | null;
  filesQueued: number;
  filesRead: number;
  urlsFound: number;
  newEndpoints: number;
  checkedAlive: number;
  checkedDead: number;
}

export interface HunterState {
  token: string | null;
  logs: LogLine[];
  logSeq: number;
  status: ScanStatus;
  config: ScanConfig | null;
  startedAt: number | null;
  finishedAt: number | null;
  reposQueued: number;
  reposDone: number;
  reposSkipped: number; // repos skipped: no new code since last scan (watch mode)
  currentRepo: string | null;
  currentFile: string | null;
  filesQueued: number;
  filesRead: number;
  urlsFound: number;
  newEndpoints: number;
  checkedAlive: number;
  checkedDead: number;
  stopRequested: boolean;
  runningScan: boolean;
  autoScan: boolean;
  autoIntervalMin: number;
  autoTimer: ReturnType<typeof setInterval> | null;
  autoLastRun: number | null;
  bootAt: number;
  scansStarted: number;
  chain247: boolean; // NEVER-STOP mode: scan → cooldown → scan → ∞
  chainCooldownUntil: number | null;
  chainRuns: number;
  lastChainError: number | null;
}

const globalRef = globalThis as unknown as { __apiHunterState?: HunterState };

function createState(): HunterState {
  return {
    token: null,
    logs: [],
    logSeq: 0,
    status: "idle",
    config: null,
    startedAt: null,
    finishedAt: null,
    reposQueued: 0,
    reposDone: 0,
    reposSkipped: 0,
    currentRepo: null,
    currentFile: null,
    filesQueued: 0,
    filesRead: 0,
    urlsFound: 0,
    newEndpoints: 0,
    checkedAlive: 0,
    checkedDead: 0,
    stopRequested: false,
    runningScan: false,
    autoScan: false,
    autoIntervalMin: 30,
    autoTimer: null,
    autoLastRun: null,
    bootAt: Date.now(),
    scansStarted: 0,
    chain247: false,
    chainCooldownUntil: null,
    chainRuns: 0,
    lastChainError: null,
  };
}

export function state(): HunterState {
  if (!globalRef.__apiHunterState) {
    globalRef.__apiHunterState = createState();
  }
  return globalRef.__apiHunterState;
}

export function log(level: LogLevel, msg: string) {
  const s = state();
  s.logSeq += 1;
  const line: LogLine = { i: s.logSeq, t: Date.now(), l: level, m: msg };
  s.logs.push(line);
  if (s.logs.length > 500) s.logs.splice(0, s.logs.length - 500);
  return line;
}

export function getLogs(since: number): LogLine[] {
  return state().logs.filter((l) => l.i > since);
}

export function resetProgress() {
  const s = state();
  s.reposQueued = 0;
  s.reposDone = 0;
  s.reposSkipped = 0;
  s.currentRepo = null;
  s.currentFile = null;
  s.filesQueued = 0;
  s.filesRead = 0;
  s.urlsFound = 0;
  s.newEndpoints = 0;
  s.checkedAlive = 0;
  s.checkedDead = 0;
}

export function getProgress(): ScanProgress {
  const s = state();
  return {
    status: s.status,
    config: s.config,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    reposQueued: s.reposQueued,
    reposDone: s.reposDone,
    reposSkipped: s.reposSkipped,
    currentRepo: s.currentRepo,
    currentFile: s.currentFile,
    filesQueued: s.filesQueued,
    filesRead: s.filesRead,
    urlsFound: s.urlsFound,
    newEndpoints: s.newEndpoints,
    checkedAlive: s.checkedAlive,
    checkedDead: s.checkedDead,
  };
}
