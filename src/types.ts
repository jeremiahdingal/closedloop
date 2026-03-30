/**
 * Core TypeScript interfaces and types for Ollama Proxy
 */

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  status: string;
  priority?: string;
  assigneeAgentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: string;
  issueId: string;
  authorAgentId?: string;
  authorUserId?: string;
  body: string;
  createdAt: string;
}

export interface Agent {
  id: string;
  name: string;
}

export interface OllamaMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface OllamaRequest {
  model: string;
  stream?: boolean;
  messages: OllamaMessage[];
  context?: {
    issueId?: string;
    taskId?: string;
    taskKey?: string;
    wakeReason?: string;
    paperclipWorkspace?: {
      cwd: string;
    };
  };
  agentId?: string;
}

export interface OllamaResponse {
  message?: {
    role: string;
    content: string;
  };
  response?: string;
}

export interface ProjectConfig {
  project: {
    name: string;
    slug: string;
    description: string;
    githubRepo: string;
    workspace: string;
  };
  techStack: Record<string, string>;
  structure: {
    monorepo: string;
    apps: Record<string, string>;
    packages: Record<string, string>;
    api: string;
    screens: string;
    hooks: string;
    stores: string;
    components: string;
  };
  packages: {
    scope: string;
    names: string[];
  };
  imports: {
    ui: string;
    app: string;
  };
  commands: Record<string, string>;
  patterns: Record<string, string>;
  coding?: {
    styling?: {
      framework?: string;
      guidance?: string;
      required?: string[];
      forbidden?: string[];
    };
  };
  paperclip: {
    companyId: string;
    agents: Record<string, string>;
    agentKeys: Record<string, string>;
    blockedAgents: string[];
    apiUrl: string;
  };
  ollama: {
    proxyPort: number;
    ollamaPort: number;
    models: Record<string, string>;
    timeouts: Record<string, number>;
    runnerBackend?: 'ollama_cli';
    runnerTimeoutMs?: number;
    stuckRunThresholdMs?: number;
    stuckRunMaxRetries?: number;
  };
  artist: {
    devServerPort: number;
    viewport: {
      width: number;
      height: number;
    };
    stepTimeoutMs: number;
    screenshotDir: string;
  };
  delegationRules: Record<string, string[]>;
  remote?: {
    appArchitect?: {
      model: string;
      apiBase: string;
    };
    rescue?: {
      model: string;
      threshold: number;
    };
  };
  epicReviewer?: {
    requireOpenPrs?: boolean;
  };
}

export interface FileValidation {
  valid: boolean;
  reason?: string;
  preservedMethods?: string[];
}

export interface CodeExtractionResult {
  written: string[];
  fileContents: Record<string, string>;
}

export interface DelegationTarget {
  name: string;
  id: string;
}

export interface RAGSearchResult {
  document: string;
  metadata: {
    path: string;
    exports: string;
    purpose: string;
    type: 'component' | 'module';
  };
  distance?: number;
}

// === Parallel Worktree Exploration ===

export interface WorktreeInfo {
  path: string;
  branch: string;
  label: string;
  issueId: string;
}

export interface ApproachHint {
  label: string;         // e.g. 'A', 'B', 'C'
  description: string;   // Strategy description for the builder
}

export interface ApproachResult {
  label: string;
  worktree: WorktreeInfo;
  buildSuccess: boolean;
  buildOutput: string;
  filesWritten: string[];
  fileContents: Record<string, string>;
  diffStats: string;     // git diff --stat output
}

export interface ExplorationState {
  issueId: string;
  approaches: ApproachHint[];
  results: ApproachResult[];
  status: 'pending' | 'running' | 'comparing' | 'merged' | 'failed';
  selectedApproach?: string;  // Winning label
  createdAt: number;
}

export interface ArtistFlow {
  name: string;
  startRoute: string;
  source: 'json' | 'heuristic' | 'fallback';
  steps: ArtistStep[];
}

export interface ArtistStep {
  action: string;
  label: string;
  target?: string;
  selectors?: string[];
  value?: string;
  timeoutMs?: number;
  optional?: boolean;
}

export interface ArtistReport {
  issueId: string;
  status: 'passed' | 'failed';
  flowName: string;
  flowSource: string;
  branchName: string;
  baseUrl: string;
  screenshots: string[];
  steps: ArtistStepResult[];
  videoPath?: string;
  videoDir: string;
  tracePath: string;
  runFile: string;
  reportFile: string;
  eventsFile: string;
  fatalError?: string;
  serverLogs?: string[];
}

export interface ArtistStepResult {
  ts: string;
  label: string;
  action: string;
  status: 'ok' | 'failed' | 'skipped';
  error?: string;
  reason?: string;
  screenshotPath?: string;
  target?: string;
  selectors?: string[];
  value?: string;
  startedAt?: string;
  finishedAt?: string;
  beforeUrl?: string;
  afterUrl?: string;
}
