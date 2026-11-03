// View models returned by the local API. The server builds them from the
// engine (or synthetic demo data); screens render them without re-deriving
// eligibility, labels or task association.

export type Side = 'a' | 'b';
export type ComparisonLabel = 'different' | 'same' | 'cannot-compare' | 'not-applicable';
export type ExactState =
  | 'changed' | 'added' | 'removed' | 'identical'
  | 'partial' | 'unknown' | 'unavailable' | 'redacted' | 'not-applicable';
export type StatusKind = 'success' | 'warning' | 'error' | 'neutral';

export interface Info {
  mode: 'engine' | 'demo';
  version: string;
  features: { runs: boolean; copy: boolean; create: boolean; clientControls: boolean; profileEdits: boolean };
  activeRun: { id: string; task: string; profiles: [string, string]; href: string } | null;
}

export interface Counts { different: number; same: number; cannotCompare: number }

export interface ProfileRef { name: string; meta?: string }

/* Landing */
export interface Overview {
  profileCount: number;
  readyToRun: number;
  sessions: { status: 'ready' | 'reading' | 'partial' | 'none'; text: string };
  runs: { available: boolean; text: string };
  setups: { text: string };
  recent: RecentItem[];
}
export interface RecentItem { kind: 'task' | 'setup' | 'saved'; title: string; meta: string; href: string }

/* Profiles */
export type ClientState = 'running' | 'not-running' | 'unknown' | 'unavailable';
export interface ClientInfo { state: ClientState; text: string }
export interface ProfileCard {
  name: string;
  isDefault: boolean;
  state: 'ready' | 'unbound' | 'unavailable';
  reason: string | null;
  signIn: string;
  binding: string;
  summary: string;
  cli: ClientInfo;
  desktop: ClientInfo;
  clientActions: ClientAction[];
  moreMenu: MenuAction[] | null;
}
export interface ClientAction { id: string; label: string; kind?: 'primary' | 'secondary'; conflict?: ClientConflict }
export interface ClientConflict { title: string; body: string }
export interface MenuAction { id: 'copy' | 'binding' | 'rename' | 'remove'; label: string; detail?: string; disabledReason?: string }
export interface ProfilesView { profiles: ProfileCard[]; notes: string[]; simulated: boolean }
export interface ClientActionResult { status: StatusKind; message: string; profile?: ProfileCard }

/* Setup comparison */
/** Ordered summary text; a part with a side is shown in that profile's colour on Different items. */
export interface SummaryPart { text: string; side?: Side }
export interface ValueBox { side: Side; label: string; value: string; mono?: boolean }
export interface DiffLine { kind: ' ' | '-' | '+' | '~'; text: string }
export interface SourceRow { side: Side | 'both'; where: string; scope: string; status: string }
export interface Fact { label: string; value: string }
export interface SetupItem {
  id: string;
  name: string;
  category: string;
  scope: string;
  label: ComparisonLabel;
  exactState: ExactState;
  exactText: string;
  reason?: string;
  summary: SummaryPart[];
  detail: {
    values?: ValueBox[];
    diff?: DiffLine[];
    note: string;
    sources: SourceRow[];
    facts: Fact[];
    evidence?: SetupItem[];
  };
  actions: { copy?: { from: Side; label: string; href: string }; packageHref?: string; guidance?: string[] };
}
export interface SetupGroup { id: string; label: string; items: SetupItem[]; counts: Counts; meta: string; hiddenSame: number }
export interface CoverageRow { area: string; a: string; b: string }
export interface SetupComparison {
  a: ProfileRef;
  b: ProfileRef;
  project: string | null;
  readAt: string;
  counts: Counts;
  limits: { text: string; coverage: CoverageRow[] } | null;
  groups: SetupGroup[];
  blocked?: string;
}
export interface SkillFile {
  path: string;
  label: ComparisonLabel;
  exactText: string;
  summary: SummaryPart[];
  diff?: DiffLine[];
  statement?: string;
  only?: { side: Side; lines: string[] };
}
export interface SkillDetail {
  name: string;
  source?: string;
  label: ComparisonLabel;
  a: ProfileRef;
  b: ProfileRef;
  coverage: string;
  toolsNote: string;
  files: SkillFile[];
  copy: { label: string; aToB: string; bToA: string; href: string } | null;
}

/* Sessions */
export type HistoryState = 'complete' | 'partial' | 'unknown';
export interface SessionRow {
  key: string;
  title: string;
  profile: string;
  client: 'cli' | 'desktop' | 'unknown';
  clientText: string;
  project: string;
  recordedAt: string;
  turns: string;
  history: HistoryState;
  historyText: string;
  startedHere?: { reportHref: string };
}
export interface SessionsView {
  sessions: SessionRow[];
  profiles: string[];
  partial: { text: string; help: string } | null;
  truncated: boolean;
}
export type AssociationBasis = 'recorded' | 'recorded-later-differ' | 'user-declared' | 'unknown';
export interface AssociationView {
  basis: Exclude<AssociationBasis, 'user-declared'>;
  title: string;
  text: string;
  suggestedVariables: string[];
  sides: { a: SessionRow; b: SessionRow };
}
export interface CompareRequest {
  left: string;
  right: string;
  sameTask?: string;
  variables?: string[];
}

/* Report */
export interface ReportSide { side: Side; profile: string; client: string; time: string; session: string }
export interface Condition {
  name: string;
  label: ComparisonLabel;
  a: string;
  b: string;
  intent: 'intended' | 'not-marked' | null;
}
export interface ReplayEvent {
  role?: string;
  id: string;
  sessionId: string;
  turnId: string | null;
  kind: string;
  label: string;
  timestamp: string | null;
  sourceLine: number | null;
  body?: string | null;
  bodyStatus: 'included' | 'omitted' | 'truncated' | 'unavailable';
  bodyReason?: string;
  callId?: string;
  relatedEventId?: string;
  linkStatus?: string;
  childSessionIds?: string[];
  sourceLines?: number[];
  status?: string;
  contentOmitted?: boolean;
}
export interface ReplaySession {
  id: string;
  parentId: string | null;
  depth?: number;
  status: string;
  reason?: string | null;
  source: { fingerprint: string | null; path?: string | null };
  limits?: { kind?: string; message?: string; omitted?: number }[];
  events: ReplayEvent[];
}
export interface SessionReplay {
  schemaVersion: 1;
  kind: 'session-replay';
  sessions: ReplaySession[];
  limits?: string[];
}
export interface CheckResult { status: StatusKind; text: string }
export interface VerificationCell { side: Side; profile: string; claim: string; checks: CheckResult[]; executionFailures?: string[] }
export interface CheckInspection {
  id: string;
  name: string;
  status: string;
  exitCode: number | null;
  origin: string;
  definitionFingerprint: string | null;
  definition: { command: string | null; purpose: string | null; timeoutMs: number | null; passCondition: string | null };
  execution: { startedAt: string | null; elapsedMs: number | null; workspaceFingerprint: string | null };
  output: { stdout: string | null; stderr: string | null; status: 'retained' | 'omitted' | 'unavailable'; truncated: boolean };
  detailNote: string | null;
}
export interface CheckAssessmentRow {
  id: string;
  name: string;
  definitionMatch: 'same' | 'different' | 'unknown' | 'one-sided';
  a: CheckInspection | null;
  b: CheckInspection | null;
}
export interface MeasureRow { name: string; a: string; b: string; caveat?: string; scope?: { a: string; b: string } }
export interface AgentMeasurement {
  id: string;
  parentId: string | null;
  name: string;
  role: string;
  durationMs: number | null;
  timingNote: string;
  counters: { input: number | null; cachedInput: number | null; output: number | null; reasoning: number | null; total: number | null };
  usageNote: string;
}
export interface TokenCounters {
  input: number | null;
  cachedInput: number | null;
  output: number | null;
  reasoning: number | null;
  total: number | null;
}
export interface WorkflowMeasurement {
  durationMs: number | null;
  timingNote: string;
  counters: TokenCounters;
  usageStatus: 'validated' | 'partial' | 'unvalidated' | 'unavailable';
  usageNote: string;
  coverageNote: string;
  runnerDurationMs: number | null;
}
export interface Report {
  ref: string;
  progressHref?: string;
  title: string;
  breadcrumb: string;
  saved: { recordedAt: string; savedAt: string; notInReport: string[] } | null;
  a: ReportSide;
  b: ReportSide;
  replay?: { a: SessionReplay | null; b: SessionReplay | null } | null;
  replayRootContext?: { a: { model: string; effort: string; requestedModel: string | null; requestedEffort: string | null };
    b: { model: string; effort: string; requestedModel: string | null; requestedEffort: string | null } };
  attempt?: { title: string; text: string; notStarted: boolean; cells: {
    side: Side; profile: string; state: 'not-started' | 'completed' | 'failed' | 'unknown'; text: string; detail: string;
  }[] };
  association: { basis: AssociationBasis; title: string; text: string };
  counts: Counts;
  summaryLine: string;
  conditions: { scopeNote?: string; rows: Condition[]; allRows?: Omit<Condition, 'intent'>[]; footer: string; all: Fact[]; setupHref: string | null };
  limits: string[];
  verification: { cells: VerificationCell[]; rows?: CheckAssessmentRow[]; none: boolean; reviews: { text: string; href: string | null } };
  timeTokens: { rows: MeasureRow[]; footer: string };
  agentMeasurements?: { a: AgentMeasurement[]; b: AgentMeasurement[] };
  workflowMeasurements?: { a: WorkflowMeasurement; b: WorkflowMeasurement };
  outcome: { scopeNote?: string; summary: string; cells?: string[]; files: { path: string; a: string; b: string; category?: 'tracked' | 'ignored' | 'mixed' | 'observed' }[]; code: string | null;
    patches?: Record<Side, { status: string; text: string | null; note: string; sourceCommit: string | null }> };
  cliCommand: string;
}
/* Reviews */
export interface ReviewCard {
  kind: 'human' | 'ai';
  reviewer: string;
  verdict: 'positive' | 'negative' | 'mixed' | 'inconclusive';
  prefers: string;
  quote: string;
  basedOn: { text: string; href: string | null }[];
  date: string;
  earlier: { verdict: string; quote: string; date: string } | null;
}
export interface ReviewTopic { title: string; meta: string; disagreement: string | null; reviews: ReviewCard[]; notReviewed: boolean }
export interface ReviewsView {
  ref: string;
  title: string;
  canPrepare?: boolean;
  canImport?: boolean;
  hasReviews?: boolean;
  reviewOptions?: ReviewTaskOptions;
  reviewTasks?: ReviewTaskSummary[];
  topics: ReviewTopic[];
  consistency: string;
  checksAfter: { status: StatusKind; text: string; by: string }[];
}
export interface ReviewPreviewView {
  token: string;
  title: string;
  evidenceFingerprint: string;
  claimScopes: string[];
  evidenceRefCount: number;
  topics: ReviewTopic[];
  disagreement: string | null;
  consistency: string;
}
export interface SavedReviewView { ref: string; title: string }
export type ReviewTaskState = 'prepared' | 'starting' | 'running' | 'waiting-for-user' | 'completed'
  | 'failed' | 'cancelled' | 'interrupted' | 'uncertain';
export interface ReviewTaskWorkspaceOption { path: string; profile?: string; available: boolean }
export interface ReviewTaskOptions {
  profiles: RunProfileOption[];
  workspaces: ReviewTaskWorkspaceOption[];
  prompt: string;
  includeRecordedContent: boolean;
  defaults: { timeoutMs: number | null };
}
export interface ReviewTaskRequest {
  profile: string;
  cwd?: string;
  prompt: string;
  includeRecordedContent: boolean;
  timeoutMs: number | null;
}
export interface ReviewTaskPreview {
  ready: boolean;
  previewToken: string | null;
  blocked: { title: string; reason: string } | null;
  title: string;
  profile: string;
  cwd: string;
  prompt: string;
  effectivePrompt: string;
  includeRecordedContent: boolean;
  executable: string;
  model: string | null;
  reasoningEffort: string | null;
  timeoutMs: number | null;
  inputs: { name: string; path: string; bytes: number; sha256: string; source: string }[];
  contentChoice: string;
  summary: string;
  limits: string[];
  willDo: string[];
  never: string[];
  simulated: boolean;
}
export interface ReviewTaskSummary { id: string; status: ReviewTaskState; createdAt: string; profile: string; summary: string }
export interface ReviewTaskSummaries { tasks: ReviewTaskSummary[] }
export interface ReviewTaskPendingRequest {
  requestId: string;
  method: string;
  params: Record<string, unknown>;
  item?: Record<string, unknown> | null;
}
export interface ReviewTaskView {
  id: string;
  threadId: string | null;
  turnId: string | null;
  status: ReviewTaskState;
  phase: string;
  createdAt: string;
  updatedAt: string;
  profile: string;
  cwd: string;
  reportRef: string;
  title: string;
  nativeSettings: Record<string, unknown> | null;
  response: { status: 'complete' | 'partial' | 'unavailable'; text: string | null; threadId: string | null; turnId: string | null } | null;
  pendingRequests: ReviewTaskPendingRequest[];
  shutdown: { status: string; groupTerminated: boolean; processStatus?: string | null; exitCode?: number | null } | null;
  error: string | null;
  cancellation: { reason: 'user-cancel' | 'coordinator-shutdown'; requestedAt: string } | null;
  limits: string[];
}
export interface ReviewTaskStartResponse { id: string }
export interface ReviewTaskDecision {
  decision?: string | Record<string, unknown>;
  permissions?: Record<string, unknown>;
  scope?: 'turn' | 'session';
  strictAutoReview?: boolean;
  answers?: Record<string, { answers: string[] }>;
}

/* Export and reopen */
export interface ExportPlan {
  ref: string;
  title: string;
  folder: string;
  name: string;
  files: [string, string];
  included: string[];
  neverIncluded: string[];
  contentFiles: string[];
  replayAvailable?: boolean;
  reviewedEvidence?: boolean;
  privacy: string;
}
export interface ExportResult { folder: string; files: string[]; contentIncluded: string; replayContentIncluded?: string; reviewPacketFingerprint?: string; reviewPacketRef?: string }
export interface SavedSummary {
  id: string;
  title: string;
  recordedAt: string;
  savedAt: string;
  kept: { label: string; value: string }[];
  ref: string;
  cliCommand: string;
  sides?: SavedReportsView['recent'][number]['sides'];
}
export interface SavedReportsView { recent: { id: string; title: string; savedAt: string; folder: string; sides?: { side: string; profile: string; state: string; detail: string; checks: string }[] | null }[] }

/* Runs */
export interface RunProfileOption { name: string; readiness: string; ready: boolean }
export interface RunOptions {
  profiles: RunProfileOption[];
  repositories: { path: string; commit: string }[];
  defaults: { timeMinutes: number; access: string; outputCap: string; outputMiB?: number; program: string; reasoningEffort?: string };
  simulated: boolean;
}
export interface RunAdvanced {
  timeMinutes: number | null;
  sandbox: 'read-only' | 'workspace-write';
  outputMiB: number;
  program: string;
  reasoningEffort: string;
  setup: { name: string; command: string }[];
}
export interface RunRequest {
  task: string;
  files: string;
  a: string;
  b: string;
  repository: string;
  commit: string;
  checks: { name: string; command: string }[];
  advanced?: RunAdvanced;
}
export interface RunPreview {
  previewToken: string | null;
  ready: boolean;
  blocked: { title: string; reason: string } | null;
  summary: string;
  limit: string;
  task: string;
  files: string;
  runs: { side: Side; profile: string; text: string; note?: string }[];
  where: string[];
  checks: string[];
  limits: string[];
  willDo: string[];
  never: string[];
  cliCommand: string;
  simulated: boolean;
}
export interface RunStep { text: string; state: 'done' | 'active' | 'waiting' | 'failed' | 'skipped' }
export interface RunView {
  id: string;
  task: string;
  meta: string;
  state: 'running' | 'finished' | 'finished-partial' | 'check-failed' | 'cancelled' | 'time-limit' | 'interrupted' | 'cannot-tidy' | 'failed';
  stateText: string;
  headline: string;
  elapsed: string;
  timeUsed: number | null;
  columns: { side: Side; profile: string; state: string; failure?: string | null; steps: RunStep[] }[];
  sofar: string;
  reportHref: string | null;
  recovery: { facts: string[]; previewToken?: string } | null;
  simulated: boolean;
}

/* Copy and create */
export interface CopyItem {
  id: string;
  name: string;
  kind: string;
  change: string;
  details?: { path: string; action: string; before: string | null; after: string | null; beforeMode: number | null; afterMode: number | null }[];
  note: string;
  selected: boolean;
}
export interface CopyPlan {
  mode: 'copy' | 'create';
  source: string;
  target: string;
  title: string;
  intro: string;
  origin: string | null;
  items: CopyItem[];
  manual: string[];
  never: string[];
  blocked: { title: string; body: string } | null;
  planToken: string;
  simulated: boolean;
}
export interface CopyResult {
  status: 'applied' | 'undone';
  title: string;
  changes: string[];
  note: string;
  undo: { id: string; explanation: string } | null;
}

export interface ApiErrorBody { error: { message: string; code: string; details?: unknown } }
