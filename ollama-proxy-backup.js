/**
 * Ollama Proxy for Paperclip (v5)
 *
 * Sits between Paperclip's HTTP adapter and Ollama instances.
 * - Fetches issue details (title, description) and comment history
 * - Injects them into the LLM conversation so agents have full context
 * - Captures LLM responses and posts them as issue comments
 * - Detects delegation in LLM output and reassigns issues via API
 *   (Paperclip auto-wakes the new assignee on reassignment)
 * - Extracts code blocks from Local Builder output and writes files
 * - Creates git branches, commits, pushes, and opens PRs
 * - Executes bash commands from Strategist/Sentinel/Deployer output
 * - Replaces Artist screenshot+vision auditing with deterministic Playwright
 *   feature recording, video capture, trace capture, milestone screenshots,
 *   and a structured visual execution report
 *
 * All agents -> single GPU Ollama instance:
 *   3201 (proxy) -> 11434 (Ollama GPU)
 *   Ollama queues requests internally -- agents wait their turn
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");

// Load project configuration (with fallback to hardcoded values)
const CONFIG_PATH = path.join(__dirname, '.paperclip', 'project.json');
let config = null;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  console.log(`[proxy] Loaded project config: ${config.project.name}`);
} catch (err) {
  console.log(`[proxy] No project config found, using hardcoded values`);
}

// Project settings (from config or hardcoded fallback)
const WORKSPACE = config?.project?.workspace || "C:\\Users\\dinga\\Projects\\shop-diary-v2";
const GH_CLI = "C:\\Program Files\\GitHub CLI\\gh";
const PAPERCLIP_API = config?.paperclip?.apiUrl || "http://127.0.0.1:3100";
const COMPANY_ID = config?.paperclip?.companyId || "ac5c469b-1f81-4f1f-9061-1dd9033ec831";

const PROXY_MAP = {
  [config?.ollama?.proxyPort || 3201]: config?.ollama?.ollamaPort || 11434,
};

const DEV_SERVER_PORT = config?.artist?.devServerPort || 3000;
const ARTIST_VIEWPORT = config?.artist?.viewport || { width: 1280, height: 800 };
const ARTIST_STEP_TIMEOUT_MS = config?.artist?.stepTimeoutMs || 15000;
const SCREENSHOT_BASE = config?.artist?.screenshotDir 
  ? path.join(__dirname, config.artist.screenshotDir)
  : path.join(__dirname, ".screenshots");

// Agent IDs (from config or hardcoded)
const AGENTS = config?.paperclip?.agents || {
  strategist: "a90b07a4-f18c-4509-9d7b-b9f16eb098d6",
  "tech lead": "dad994d7-5d3e-4101-ae57-82c7be9b778b",
  "local builder": "caf931bf-516a-409f-813e-a29e14decb10",
  "coder remote": "954ce225-6dc8-4df7-8917-b597afbae60b",
  reviewer: "eace3a19-bded-4b90-827e-cfc00f3900bd",
  sentinel: "c7fb4dae-8ac3-4795-b1f6-d14db2021035",
  deployer: "5e234916-47ef-41a2-8c07-e9376ee6aa9c",
  artist: "787cbd9e-d10b-4bca-b486-e7f5fd99d184",
};

// Reverse lookup: ID -> name
const AGENT_NAMES = {};
for (const [name, id] of Object.entries(AGENTS)) {
  AGENT_NAMES[id] = name;
}

// Valid delegation paths (org chart) - from config or hardcoded
const DELEGATION_RULES = config?.delegationRules ? 
  Object.fromEntries(
    Object.entries(config.delegationRules).map(([role, targets]) => [
      AGENTS[role] || role,
      targets.map(t => AGENTS[t] || t)
    ])
  )
  : {
  [AGENTS.strategist]: [AGENTS["tech lead"], AGENTS.reviewer, AGENTS.sentinel, AGENTS.artist],
  [AGENTS["tech lead"]]: [AGENTS["local builder"]],
  [AGENTS.reviewer]: [AGENTS.artist],
  [AGENTS.sentinel]: [AGENTS.deployer],
};

// Agent API keys (Bearer tokens) - from config or hardcoded
const AGENT_KEYS = config?.paperclip?.agentKeys || {
  [AGENTS.strategist]: "pcp_48d784f6edd3a907e7700cda9f93e36fc0d1030f4a6b6d04",
  [AGENTS["tech lead"]]: "pcp_ef721504b998e79742f272ad196be3952c28d5921dc4ba9a",
  [AGENTS["local builder"]]: "pcp_0fbcdff3e8a50df48ab7c94cd3f4409cd492b6eb84c683d8",
  [AGENTS.reviewer]: "pcp_650990c0932107838084b2adaf47fdbfb9407c649243211e",
  [AGENTS.sentinel]: "pcp_268a568963f01698e27a232c9b911d96fa3504b214232b97",
  [AGENTS.deployer]: "pcp_ad33d0ec65c082f7b46feef3233872548ac64b606e0e7541",
  [AGENTS.artist]: "pcp_6b6711a3a014c59c92416ec479077557a021087ba08bc280",
};

// Blocked agents - from config or hardcoded
const BLOCKED_AGENTS = new Set(config?.paperclip?.blockedAgents || [AGENTS["coder remote"]]);

// Track recent delegations to prevent duplicates
// Key: "issueId:targetId", Value: timestamp
const recentDelegations = {};
const DELEGATION_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// Track how many times Local Builder has run on an issue
// Key: issueId, Value: number of completed passes
// Pass 1 = initial code, Pass 2+ = post-feedback revision (creates PR)
const issueBuilderPasses = {};

// Lock per issue to prevent concurrent Local Builder processing
// Key: issueId, Value: true if currently processing
const issueProcessingLock = {};

// Lock per issue to prevent concurrent Artist processing
const artistProcessingLock = {};

// Cache agent names from API (for comment history display)
const agentNameCache = {};
// Pre-populate from our known map
for (const [name, id] of Object.entries(AGENTS)) {
  agentNameCache[id] = name.charAt(0).toUpperCase() + name.slice(1);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(value) {
  return String(value || "item")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function appendNdjson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(data) + "\n");
}

function listPngFilesRecursive(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listPngFilesRecursive(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".png")) {
      results.push(full);
    }
  }
  return results.sort();
}

function normalizeRoute(route) {
  if (!route) return "/";
  if (route.startsWith("http://") || route.startsWith("https://")) return route;
  return route.startsWith("/") ? route : `/${route}`;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function getAgentName(agentId) {
  if (!agentId) return "unknown";
  if (agentNameCache[agentId]) return agentNameCache[agentId];
  try {
    const res = await fetch(`${PAPERCLIP_API}/api/agents/${agentId}`);
    if (res.ok) {
      const data = await res.json();
      agentNameCache[agentId] = data.name;
      return data.name;
    }
  } catch {}
  return agentId.slice(0, 8);
}

async function getIssueDetails(issueId) {
  try {
    const res = await fetch(`${PAPERCLIP_API}/api/issues/${issueId}`);
    if (res.ok) return res.json();
  } catch {}
  return null;
}

async function getIssueComments(issueId) {
  try {
    const res = await fetch(
      `${PAPERCLIP_API}/api/issues/${issueId}/comments`
    );
    if (res.ok) return res.json();
  } catch {}
  return [];
}

async function patchIssue(issueId, payload) {
  try {
    const res = await fetch(`${PAPERCLIP_API}/api/issues/${issueId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function findAssignedIssue(agentId) {
  try {
    const res = await fetch(
      `${PAPERCLIP_API}/api/companies/${COMPANY_ID}/issues`
    );
    if (res.ok) {
      const issues = await res.json();
      const list = Array.isArray(issues) ? issues : (issues.issues || issues.data || []);
      // Find open issues assigned to this agent
      const assigned = list.filter(
        (i) => i.assigneeAgentId === agentId && i.status !== "done" && i.status !== "cancelled"
      );
      if (assigned.length > 0) {
        // Return the most recently updated one
        assigned.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        return assigned[0].id;
      }
    }
  } catch {}
  return null;
}

function extractIssueId(body) {
  const ctx = body.context;
  if (!ctx) return null;
  return ctx.issueId || ctx.taskId || ctx.taskKey || null;
}

function extractAgentId(body) {
  return body.agentId || null;
}

function truncate(str, max) {
  if (!str) return str;
  if (str.length <= max) return str;
  return str.slice(0, max) + "\n\n... (truncated)";
}

// Strip characters that can't be stored in WIN1252 PostgreSQL encoding
function sanitizeForWin1252(str) {
  if (!str) return str;
  return str
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2014/g, "--")
    .replace(/\u2013/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u2192/g, "->")
    .replace(/\u2190/g, "<-")
    .replace(/\u2022/g, "*")
    .replace(/\u00a0/g, " ")
    .replace(/[^\x00-\xFF]/g, "");
}

async function postComment(issueId, agentId, content, retries = 3) {
  const body = JSON.stringify({
    body: sanitizeForWin1252(content),
  });
  // Use agent Bearer token so comment is attributed to the agent
  const headers = { "Content-Type": "application/json" };
  if (agentId && AGENT_KEYS[agentId]) {
    headers["Authorization"] = `Bearer ${AGENT_KEYS[agentId]}`;
  }
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(
        `${PAPERCLIP_API}/api/issues/${issueId}/comments`,
        {
          method: "POST",
          headers,
          body,
        }
      );
      if (!res.ok) {
        const text = await res.text();
        console.error(
          `[proxy] Failed to post comment: ${res.status} ${text}`
        );
      } else {
        console.log(`[proxy] Posted comment to issue ${issueId.slice(0, 8)}`);
      }
      return; // success or server error, don't retry
    } catch (err) {
      console.error(`[proxy] Error posting comment (attempt ${attempt}/${retries}):`, err.message);
      if (attempt < retries) {
        await sleep(2000 * attempt);
      }
    }
  }
}

/**
 * Detect delegation in LLM output and reassign the issue.
 * Paperclip auto-wakes the new assignee when assigneeAgentId changes.
 */
async function detectAndDelegate(issueId, agentId, content) {
  const allowedTargets = DELEGATION_RULES[agentId];
  if (!allowedTargets) {
    console.log(`[proxy] No delegation rules for agent ${agentId}`);
    return;
  }

  // Strip markdown formatting so **Tech Lead** matches as "tech lead"
  const clean = content.replace(/\*\*/g, "").replace(/_/g, "").toLowerCase();

  // Agent names to search for, with variations
  const AGENT_ALIASES = {
    "tech lead": AGENTS["tech lead"],
    "tech lead (engineering)": AGENTS["tech lead"],
    "local builder": AGENTS["local builder"],
    "local builder (engineer)": AGENTS["local builder"],
    reviewer: AGENTS.reviewer,
    sentinel: AGENTS.sentinel,
    deployer: AGENTS.deployer,
    artist: AGENTS.artist,
    "artist (ui/ux)": AGENTS.artist,
  };

  // Look for any mention of agent names in the content
  const found = [];
  for (const [alias, targetId] of Object.entries(AGENT_ALIASES)) {
    if (clean.includes(alias) && allowedTargets.includes(targetId)) {
      if (!BLOCKED_AGENTS.has(targetId)) {
        found.push({ name: alias, id: targetId });
      } else {
        console.log(`[proxy] Skipped delegation to ${alias} (blocked)`);
      }
    }
  }

  console.log(`[proxy] Delegation check: found ${found.length} targets`, found.map(f => f.name));

  if (found.length === 0) {
    console.log(`[proxy] No valid delegation targets found in content`);
    console.log(`[proxy] Content preview (first 800 chars):`, content.substring(0, 800).replace(/\n/g, "\\n"));
    console.log(`[proxy] Clean preview (first 800 chars):`, clean.substring(0, 800).replace(/\n/g, "\\n"));
    // Check for specific patterns
    console.log(`[proxy] Has 'assign to':`, clean.includes("assign to"));
    console.log(`[proxy] Has 'delegate':`, clean.includes("delegate"));
    console.log(`[proxy] Has 'local builder':`, clean.includes("local builder"));
    console.log(`[proxy] Has 'tech lead':`, clean.includes("tech lead"));
    return;
  }

  // Delegate to the first valid target (highest priority in org chart)
  const target = found[0];

  // Dedup: skip if we already delegated this issue to this target recently
  const dedupKey = `${issueId}:${target.id}`;
  const lastDelegation = recentDelegations[dedupKey];
  if (lastDelegation && Date.now() - lastDelegation < DELEGATION_COOLDOWN_MS) {
    console.log(`[proxy] Skipped duplicate delegation ${issueId.slice(0, 8)} -> ${target.name} (cooldown)`);
    return;
  }

  // Reassign the issue via Paperclip API -- this triggers auto-wakeup
  try {
    const res = await fetch(`${PAPERCLIP_API}/api/issues/${issueId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assigneeAgentId: target.id }),
    });
    if (res.ok) {
      recentDelegations[dedupKey] = Date.now();
      const fromName = AGENT_NAMES[agentId] || agentId.slice(0, 8);
      console.log(
        `[proxy] DELEGATED issue ${issueId.slice(0, 8)}: ${fromName} -> ${target.name} (auto-wakeup triggered)`
      );
    } else {
      const text = await res.text();
      console.error(`[proxy] Delegation failed: ${res.status} ${text}`);
    }
  } catch (err) {
    console.error(`[proxy] Delegation error:`, err.message);
  }
}

// Agents allowed to execute bash commands
const BASH_AGENTS = new Set([
  AGENTS.strategist,
  AGENTS.sentinel,
  AGENTS.deployer,
  AGENTS.reviewer,
]);

// Dangerous command patterns to block
const BLOCKED_COMMANDS = [
  /rm\s+-rf\s+\//i,
  /del\s+\/s/i,
  /format\s+[a-z]:/i,
  /mkfs/i,
  /dd\s+if=/i,
  />\s*\/dev\/sd/i,
  /shutdown/i,
  /reboot/i,
];

/**
 * Validate file content before writing. Returns { valid: boolean, reason?: string }.
 */
function validateFileContent(filePath, code) {
  // Validate package.json files
  if (filePath.endsWith('package.json')) {
    try {
      const pkg = JSON.parse(code);
      
      // Check for required fields
      if (!pkg.name) {
        return { valid: false, reason: 'package.json missing "name" field' };
      }
      
      // Check if this looks like a complete package.json (has scripts or dependencies)
      const hasScripts = pkg.scripts && Object.keys(pkg.scripts).length > 0;
      const hasDeps = pkg.dependencies || pkg.devDependencies || pkg.peerDependencies;
      const hasDepsCount = hasDeps ? Object.keys(hasDeps).length : 0;
      
      // If original file exists, compare to ensure we're not deleting content
      const fullPath = path.join(WORKSPACE, filePath);
      if (fs.existsSync(fullPath)) {
        const original = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        const origDeps = { ...original.dependencies, ...original.devDependencies };
        const newDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        
        // Warn if we're removing more than 50% of dependencies
        const origDepCount = Object.keys(origDeps).length;
        const newDepCount = Object.keys(newDeps).length;
        if (origDepCount > 0 && newDepCount < origDepCount * 0.5) {
          return { 
            valid: false, 
            reason: `package.json would delete ${origDepCount - newDepCount} dependencies (${origDepCount} → ${newDepCount}). Did you mean to modify instead of replace?`
          };
        }
      }
      
      // New package.json should have at least scripts OR dependencies
      if (!hasScripts && hasDepsCount === 0) {
        return { valid: false, reason: 'package.json has no scripts or dependencies' };
      }
    } catch (e) {
      return { valid: false, reason: `Invalid JSON: ${e.message}` };
    }
  }
  
  return { valid: true };
}

/**
 * Extract code blocks with file paths from LLM output and write them to disk.
 * Returns array of written file paths (relative to workspace).
 */
function applyCodeBlocks(content) {
  const written = [];
  const fileContents = {}; // path -> content (for branch-safe commits)

  // Debug: log content stats to help diagnose extraction failures
  console.log(`[proxy] applyCodeBlocks: content length=${content.length}, has FILE:=${content.includes("FILE:")}, backticks=${(content.match(/```/g) || []).length}`);
  console.log(`[proxy] applyCodeBlocks content preview: ${content.substring(0, 500)}`);

  // Match FILE: path before code block, OR // path or -- path as first line inside code block
  // Pattern 1: FILE: path/to/file.ext\n```lang\ncode\n``` (also handles **FILE: path** with bold markdown)
  const fileBeforeBlock = /\*{0,2}FILE:\s*([\w./\\-]+\.\w+)\s*\*{0,2}\s*\n```[^\n]*\n([\s\S]*?)```/g;
  // Pattern 2: ```lang\n// path/to/file.ext\ncode\n```
  const fileInsideBlock = /```[^\n]*\n(?:\/\/|--|#)\s*([\w./\\-]+\.\w+)\s*\n([\s\S]*?)```/g;

  for (const blockRegex of [fileBeforeBlock, fileInsideBlock]) {
    let match;
    while ((match = blockRegex.exec(content)) !== null) {
      let filePath = match[1].trim().replace(/`/g, "");
      const code = match[2];

      console.log(`[proxy] applyCodeBlocks: matched file="${filePath}", code length=${code.length}`);

      // Skip if already written by a previous pattern
      if (written.includes(filePath)) {
        console.log(`[proxy] applyCodeBlocks: skipping "${filePath}" (already written)`);
        continue;
      }

      // Safety: reject absolute paths and traversal (but allow root-level files)
      if (path.isAbsolute(filePath) || filePath.includes("..")) {
        console.log(`[proxy] Rejected unsafe path: ${filePath}`);
        continue;
      }

      const fullPath = path.join(WORKSPACE, filePath);
      if (!path.resolve(fullPath).startsWith(path.resolve(WORKSPACE))) {
        console.log(`[proxy] Path escapes workspace: ${filePath}`);
        continue;
      }

      // Validate file content (basic validation like package.json structure)
      const validation = validateFileContent(filePath, code);
      if (!validation.valid) {
        console.log(`[proxy] Rejected ${filePath}: ${validation.reason}`);
        continue;
      }

      // For critical files, check for destructive changes
      if (fs.existsSync(fullPath)) {
        const oldContent = fs.readFileSync(fullPath, 'utf8');
        const criticalValidation = validateCriticalFileChanges(filePath, oldContent, code);
        if (!criticalValidation.valid) {
          console.log(`[proxy] BLOCKED destructive change to ${filePath}: ${criticalValidation.reason}`);
          continue;
        }
      } else {
        // For NEW files, check if they might be duplicating existing functionality
        const duplicationCheck = validateNewFileDuplication(filePath, code);
        if (!duplicationCheck.valid) {
          console.log(`[proxy] BLOCKED new file ${filePath}: ${duplicationCheck.reason}`);
          continue;
        }
      }

      written.push(filePath);
      fileContents[filePath] = code;
      console.log(`[proxy] Extracted file: ${filePath}`);
    }
  }
  console.log(`[proxy] applyCodeBlocks: total files extracted=${written.length}`);
  return { written, fileContents };
}

/**
 * Check if a new file appears to duplicate existing functionality.
 * Returns { valid: boolean, reason?: string }.
 */
function validateNewFileDuplication(filePath, code) {
  const basename = path.basename(filePath, path.extname(filePath));
  const dirname = path.dirname(filePath);
  
  // Check for store files that might duplicate existing stores
  if (filePath.includes('/store/') && filePath.endsWith('.ts')) {
    // Check if there's already a store file with similar functionality
    const existingStores = [
      'useUserStore',
      'useShopStore', 
      'useCartStore',
      'useAuthStore'
    ];
    
    for (const existingStore of existingStores) {
      const existingPath = path.join(dirname, `${existingStore}.ts`);
      if (fs.existsSync(path.join(WORKSPACE, existingPath))) {
        // Check if the new file has similar exports/functionality
        if (code.includes('create<') && code.includes('persist')) {
          return {
            valid: false,
            reason: `New store file may duplicate existing ${existingStore}.ts. Modify the existing file instead of creating a new store.`
          };
        }
      }
    }
  }
  
  // Check for type files that might duplicate existing types
  if (filePath.includes('/types/') && filePath.endsWith('.ts')) {
    const existingTypeFiles = [
      'auth.schema.ts',
      'shop.schema.ts',
      'items.schema.ts'
    ];
    
    for (const existingFile of existingTypeFiles) {
      const existingPath = path.join(WORKSPACE, 'packages/app/types/schemas', existingFile);
      if (fs.existsSync(existingPath)) {
        // Check if new file exports types that might overlap
        const newExports = code.match(/export\s+(?:interface|type)\s+(\w+)/g) || [];
        if (newExports.length > 2) {
          return {
            valid: false,
            reason: `New type file may duplicate types in ${existingFile}. Add types to the existing schema file instead.`
          };
        }
      }
    }
  }
  
  return { valid: true };
}

/**
 * Get the branch name for an issue.
 */
async function getBranchName(issueId) {
  let issue;
  try { issue = await getIssueDetails(issueId); } catch {}
  const identifier = issue?.identifier || issueId.slice(0, 8);
  const title = issue?.title || "Code changes";
  return `${identifier}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`.replace(/-+$/, "");
}

/**
 * Commit changed files to a branch, push, and run build validation.
 * Does NOT create a GitHub PR -- that happens after review cycle.
 */
async function commitAndPush(issueId, files, fileContents) {
  if (files.length === 0) return;

  const branchName = await getBranchName(issueId);
  let issue;
  try { issue = await getIssueDetails(issueId); } catch {}
  const identifier = issue?.identifier || issueId.slice(0, 8);
  const title = issue?.title || "Code changes";
  const opts = { cwd: WORKSPACE, stdio: "pipe", timeout: 30000 };

  try {
    // Discard any uncommitted changes on master before switching
    try { execSync("git checkout -- .", opts); } catch {}

    // Create and switch to branch from master
    try {
      execSync(`git checkout -b ${branchName} master`, opts);
    } catch {
      // Branch might exist, just switch
      execSync(`git checkout ${branchName}`, opts);
    }

    // Write files directly onto the branch (no stash needed)
    for (const f of files) {
      const fullPath = path.join(WORKSPACE, f);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, fileContents[f]);
    }

    // Stage the specific files
    for (const f of files) {
      execSync(`git add "${f}"`, opts);
    }

    // Commit
    const pass = issueBuilderPasses[issueId] || 1;
    const commitMsg = `${identifier}: ${title} (pass ${pass})`;
    try {
      execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, opts);
      console.log(`[proxy] Committed: ${commitMsg}`);
    } catch (commitErr) {
      const commitStdout = commitErr.stdout?.toString() || "";
      const commitStderr = commitErr.stderr?.toString() || "";
      const commitStatus = commitErr.status ?? 1;
      console.error(`[proxy] Git commit FAILED (exit ${commitStatus}):`);
      console.error(`[proxy] Commit stdout: ${commitStdout}`);
      console.error(`[proxy] Commit stderr: ${commitStderr}`);
      console.error(`[proxy] Files staged: ${files.join(", ")}`);
      
      // Check if there are any changes to commit
      try {
        const gitStatus = execSync("git status --porcelain", opts).toString();
        console.log(`[proxy] Git status:\n${gitStatus}`);
      } catch {}
      
      throw new Error(`Git commit failed: ${commitStderr || commitStdout || "unknown error"}`);
    }

    // Push
    try {
      execSync(`git push -u origin ${branchName}`, { ...opts, timeout: 60000 });
      console.log(`[proxy] Pushed branch: ${branchName}`);
    } catch (err) {
      console.error(`[proxy] Push failed (no remote?):`, err.message);
      await postComment(issueId, null, `_Code committed to branch \`${branchName}\` (${files.length} files). Push failed: ${err.message}_`);
      execSync("git checkout master", opts);
      return;
    }

    await postComment(issueId, null,
      `_Code committed to branch \`${branchName}\` (pass ${pass})_\n\nFiles:\n${files.map(f => "- `" + f + "`").join("\n")}`
    );

    // Run build validation on the branch
    console.log(`[proxy] Running build validation on branch ${branchName}...`);
    try {
      // Clear turbo cache to ensure actual build (not cached) validation
      try { execSync("turbo prune --scope=@shop-diary/api 2>nul || yarn cache clean", { cwd: WORKSPACE, stdio: "pipe" }); } catch {}
      execSync("yarn build --force", { ...opts, timeout: 120000 });
      console.log(`[proxy] Build PASSED on ${branchName}`);
      await postComment(issueId, null, `_Build validation: PASSED_`);
    } catch (buildErr) {
      const buildStdout = buildErr.stdout?.toString() || "";
      const buildStderr = buildErr.stderr?.toString() || "";
      const buildOutput = truncate((buildStdout + "\n" + buildStderr).trim(), 3000);
      console.error(`[proxy] Build FAILED on ${branchName}`);
      await postComment(issueId, null,
        `_Build validation: FAILED_\n\`\`\`\n${buildOutput}\n\`\`\``
      );
    }

    // Switch back to master
    execSync("git checkout master", opts);
  } catch (err) {
    console.error(`[proxy] Git workflow error:`, err.message);
    try { execSync("git checkout master", opts); } catch {}
    await postComment(issueId, null, `_Git workflow error: ${err.message}_`);
  }
}

/**
 * Create a GitHub PR for the branch (called only after review cycle is complete).
 * Includes Artist screenshots in the PR body if available.
 */
async function createPullRequest(issueId) {
  const branchName = await getBranchName(issueId);
  let issue;
  try { issue = await getIssueDetails(issueId); } catch {}
  const identifier = issue?.identifier || issueId.slice(0, 8);
  const title = issue?.title || "Code changes";
  const commitMsg = `${identifier}: ${title}`;
  const opts = { cwd: WORKSPACE, stdio: "pipe", timeout: 30000 };

  try {
    // Check if an OPEN PR already exists for this branch
    let existingPr = "";
    try {
      const prState = execSync(
        `"${GH_CLI}" pr view ${branchName} --json url,state --jq "select(.state==\\"OPEN\\") | .url"`,
        { ...opts, timeout: 30000 }
      ).toString().trim();
      existingPr = prState;
    } catch {}

    if (existingPr) {
      console.log(`[proxy] PR already exists (open): ${existingPr}`);
      await postComment(issueId, null, `_PR already exists: ${existingPr}_`);
      return;
    }

    // Checkout the branch to add screenshots
    try {
      execSync(`git checkout ${branchName}`, opts);
    } catch {
      console.error(`[proxy] Could not checkout ${branchName} to add screenshots`);
    }

    // Collect screenshots from the per-issue dir (outside workspace, git-safe)
    const screenshotFiles = [];
    const screenshotDir = path.join(SCREENSHOT_BASE, issueId.slice(0, 8));
    const pngs = listPngFilesRecursive(screenshotDir);

    if (pngs.length > 0) {
      // Copy screenshots into a PR-visible directory on the branch
      const prScreenshotDir = path.join(WORKSPACE, "docs", "screenshots", identifier.toLowerCase());
      fs.mkdirSync(prScreenshotDir, { recursive: true });

      for (const pngPath of pngs) {
        const png = path.basename(pngPath);
        fs.copyFileSync(pngPath, path.join(prScreenshotDir, png));
        screenshotFiles.push(`docs/screenshots/${identifier.toLowerCase()}/${png}`);
      }

      // Stage and commit
      for (const f of screenshotFiles) {
        execSync(`git add "${f}"`, opts);
      }
      try {
        execSync(`git commit -m "${identifier}: add Artist screenshots"`, opts);
        execSync(`git push origin ${branchName}`, { ...opts, timeout: 60000 });
        console.log(`[proxy] Committed ${screenshotFiles.length} screenshots to ${branchName}`);
      } catch (err) {
        console.log(`[proxy] Screenshot commit/push note: ${err.message}`);
      }
    }

    // Switch back to master
    try { execSync("git checkout master", opts); } catch {}

    // Build PR body with screenshot images
    const GITHUB_REPO = "jeremiahdingal/shop-diary-v2";
    let prBody = `Auto-generated from issue ${identifier}\n\n`;
    prBody += `## Changes\n(see commits on branch)\n\n`;

    // Generate diff summary for PR body
    try {
      const diffStat = execSync(`git diff --stat master..${branchName}`, { ...opts, timeout: 30000 }).toString().trim();
      const diffShort = execSync(`git diff --name-only master..${branchName}`, { ...opts, timeout: 30000 }).toString().trim();
      
      if (diffStat) {
        prBody += `## Files Changed\n\n\`\`\`\n${diffStat}\n\`\`\`\n\n`;
        prBody += `**Warning:** Review the changes carefully before merging. Check that package.json files retain all necessary dependencies.\n\n`;
      }
    } catch (e) {
      console.log(`[proxy] Could not generate diff summary: ${e.message}`);
    }

    if (screenshotFiles.length > 0) {
      prBody += `## Screenshots (Artist Feature Recording)\n\n`;
      for (const f of screenshotFiles) {
        const routeName = path.basename(f, ".png");
        const rawUrl = `https://github.com/${GITHUB_REPO}/blob/${branchName}/${f}?raw=true`;
        prBody += `### \`${routeName}\`\n![${routeName}](${rawUrl})\n\n`;
      }
    }

    // Create PR (explicit --head so gh doesn't use current branch which is master)
    const prOutput = execSync(
      `"${GH_CLI}" pr create --head "${branchName}" --title "${commitMsg.replace(/"/g, '\\"')}" --body "${prBody.replace(/"/g, '\\"')}"`,
      { ...opts, timeout: 60000 }
    ).toString().trim();
    console.log(`[proxy] PR created: ${prOutput}`);
    await postComment(issueId, null, `_PR created (with ${screenshotFiles.length} screenshots): ${prOutput}_`);
  } catch (err) {
    console.error(`[proxy] PR creation failed:`, err.message);
    await postComment(issueId, null, `_Branch \`${branchName}\` pushed. PR creation failed: ${err.message}_`);
    try { execSync("git checkout master", { cwd: WORKSPACE, stdio: "pipe" }); } catch {}
  }
}

/**
 * Execute bash code blocks from agent output and post results as comments.
 * Returns true if any commands were executed.
 */
async function executeBashBlocks(issueId, agentId, content) {
  if (!BASH_AGENTS.has(agentId)) return false;

  const bashRegex = /```(?:bash|shell|sh)\n([\s\S]*?)```/g;
  let match;
  let commandsExecuted = 0;
  while ((match = bashRegex.exec(content)) !== null) {
    let command = match[1].trim();
    if (!command) continue;

    // Strip comment lines (# ...) for Windows compatibility
    command = command.split('\n').filter(line => !line.trim().startsWith('#')).join('\n').trim();
    if (!command) continue;

    // Convert Unix commands to Windows equivalents
    command = command
      .replace(/\bls\s+-la\b/g, 'dir')
      .replace(/\bls\s+-l\b/g, 'dir')
      .replace(/\bls\s+-a\b/g, 'dir /a')
      .replace(/\bls\b/g, 'dir')
      .replace(/\bdir\s+-la\b/g, 'dir')  // Handle already-converted ls -la
      .replace(/\bdir\s+-l\b/g, 'dir')
      .replace(/\bdir\s+-a\b/g, 'dir /a')
      .replace(/\bcat\b/g, 'type')
      .replace(/\bgrep\b/g, 'findstr')
      .replace(/\bfind\b/g, 'dir /s /b')
      .replace(/\brm\b/g, 'del')
      .replace(/\bmv\b/g, 'move')
      .replace(/\bcp\b/g, 'copy')
      .replace(/\bchmod\b/g, 'attrib')
      .replace(/\bhead\s+-\d+\b/g, 'more')  // head -20 → more
      .replace(/\btail\s+-\d+\b/g, 'more')  // tail -20 → more
      .replace(/\bhead\b/g, 'more')
      .replace(/\btail\b/g, 'more')
      .replace(/\|/g, '|') // pipes work in both
      .replace(/\b\/dev\/null\b/g, 'nul')
      // Strip unsupported more command arguments (like more -20)
      .replace(/\bmore\s+-\d+\b/g, 'more')
      // Convert forward slashes to backslashes in file paths (after command translation)
      // Match paths like packages/app/foo.ts or packages/app/ but not command flags like /s /b
      .replace(/([a-zA-Z]\w*\/)+[a-zA-Z]\w*(?:\.\w+)?\/?/g, (match) => match.replace(/\//g, '\\'));

    // Safety check
    if (BLOCKED_COMMANDS.some(rx => rx.test(command))) {
      console.log(`[proxy] BLOCKED dangerous command: ${command}`);
      await postComment(issueId, agentId, `_Blocked dangerous command: \`${command}\`_`);
      continue;
    }

    console.log(`[proxy] Executing bash for ${AGENT_NAMES[agentId] || "unknown"}: ${command.slice(0, 80)}`);

    try {
      const output = execSync(command, {
        cwd: WORKSPACE,
        stdio: "pipe",
        timeout: 30000,
        shell: true,
      }).toString();

      const truncOutput = truncate(output, 2000);
      await postComment(
        issueId,
        agentId,
        `_Command: \`${command}\`_\n_Exit code: 0_\n\`\`\`\n${truncOutput}\n\`\`\``
      );
      commandsExecuted++;
    } catch (err) {
      const stderr = err.stderr?.toString() || err.message;
      const stdout = err.stdout?.toString() || "";
      const exitCode = err.status ?? 1;
      const truncOutput = truncate((stdout + "\n" + stderr).trim(), 2000);
      await postComment(
        issueId,
        agentId,
        `_Command: \`${command}\`_\n_Exit code: ${exitCode}_\n\`\`\`\n${truncOutput}\n\`\`\``
      );
      commandsExecuted++;
    }
  }
  return commandsExecuted > 0;
}

async function buildIssueContext(issueId, currentAgentId) {
  const [issue, comments] = await Promise.all([
    getIssueDetails(issueId),
    getIssueComments(issueId),
  ]);

  if (!issue) return null;

  const currentAgentName = AGENT_NAMES[currentAgentId] || "unknown";

  // Build the issue briefing
  let briefing = `== ISSUE: ${issue.identifier || "unknown"} ==\n`;
  briefing += `Title: ${issue.title}\n`;
  briefing += `Status: ${issue.status}\n`;
  briefing += `Priority: ${issue.priority || "medium"}\n`;

  if (issue.description) {
    briefing += `\nDescription:\n${issue.description}\n`;
  }

  // Strategist gets full project context for planning
  if (currentAgentId === AGENTS.strategist) {
    briefing += `\n\n== PROJECT CONTEXT FOR PLANNING ==\n`;
    const projectContext = await buildStrategistProjectContext();
    briefing += projectContext;
  }

  briefing += `\n== YOUR ASSIGNMENT ==\n`;
  briefing += `You are: ${currentAgentName}\n`;
  briefing += `You were assigned this issue. Read the comment history for context and any specific task instructions from upstream agents.\n`;
  briefing += `When you are done with YOUR part, clearly state your output/decision. If you need to delegate sub-work to a direct report, name the agent explicitly (e.g. "Agent: Tech Lead" or "Assign to: Local Builder").\n`;
  briefing += `Do NOT re-analyze or re-plan work that has already been delegated in the comment history.\n`;

  // Add comment history as conversation context
  if (comments.length > 0) {
    const sorted = comments.sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
    // Keep last 5 comments (newest first) to avoid blowing context on smaller models
    const recent = sorted.slice(0, 5);

    briefing += "\n== COMMENT HISTORY (newest first) ==\n";
    for (const c of recent) {
      const authorName = c.authorAgentId
        ? await getAgentName(c.authorAgentId)
        : c.authorUserId || "user";
      briefing += `\n[${authorName}]:\n${truncate(c.body, 3000)}\n`;
    }
  }

  return briefing;
}

/**
 * Build project context for Strategist planning.
 * Tries to read PROJECT_STRUCTURE.md first (compact summary).
 * If not found, scans the directory structure.
 */
async function buildStrategistProjectContext() {
  const structurePath = path.join(WORKSPACE, 'PROJECT_STRUCTURE.md');
  
  // Try to read PROJECT_STRUCTURE.md first (preferred - compact summary)
  if (fs.existsSync(structurePath)) {
    try {
      const content = fs.readFileSync(structurePath, 'utf8');
      const truncated = truncate(content, 8000); // Limit to 8000 chars for context
      return `\n== PROJECT STRUCTURE (from PROJECT_STRUCTURE.md) ==\n${truncated}\n`;
    } catch (err) {
      console.log(`[proxy] Could not read PROJECT_STRUCTURE.md: ${err.message}`);
    }
  }

  // Fallback: scan directory structure
  console.log(`[proxy] PROJECT_STRUCTURE.md not found, scanning directory...`);
  const dirStructure = await scanDirectoryStructure();
  return `\n== PROJECT DIRECTORY STRUCTURE ==\n${dirStructure}\n`;
}

/**
 * Scan the workspace directory and return a structured text representation.
 * Excludes node_modules, .git, and other large/irrelevant directories.
 */
function scanDirectoryStructure() {
  const excludedDirs = new Set(['node_modules', '.git', '.turbo', '.screenshots', 'e2e-tests', 'dist', 'build', '.next']);
  const lines = [];
  
  function scanDir(dirPath, indent = '') {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const dirs = [];
    const files = [];
    
    for (const entry of entries) {
      if (excludedDirs.has(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        dirs.push(entry.name);
      } else {
        files.push(entry.name);
      }
    }
    
    // Sort for consistent output
    dirs.sort();
    files.sort();
    
    // Add files at this level
    for (const file of files) {
      lines.push(`${indent}${file}`);
    }
    
    // Add directories with their contents
    for (const dir of dirs) {
      lines.push(`${indent}${dir}/`);
      scanDir(path.join(dirPath, dir), indent + '  ');
    }
  }
  
  try {
    scanDir(WORKSPACE);
    const result = lines.join('\n');
    return truncate(result, 10000); // Limit to 10000 chars
  } catch (err) {
    return `Error scanning directory: ${err.message}`;
  }
}

/**
 * Build enhanced context for Local Builder including existing file contents.
 * This prevents destructive rewrites by showing the LLM what already exists.
 * IMPORTANT: Keep context minimal to focus on implementation, not analysis.
 */
async function buildLocalBuilderContext(issueId, currentAgentId) {
  const baseContext = await buildIssueContext(issueId, currentAgentId);
  if (!baseContext) return null;

  // Get comments to find which files are being discussed
  const comments = await getIssueComments(issueId);
  const filesToRead = new Set();

  // Extract file paths from Tech Lead's task assignment (most recent relevant comment)
  const filePathRegex = /[`']?([\w./\\-]+\.(tsx?|json))[`']?/g;
  for (const comment of comments.slice(0, 5)) {
    // Prioritize Tech Lead's task assignments
    if (comment.authorAgentId === AGENTS["tech lead"]) {
      const matches = comment.body.matchAll(filePathRegex);
      for (const match of matches) {
        const filePath = match[1];
        if (filePath.match(/\.(tsx?|json)$/)) {
          filesToRead.add(filePath);
        }
      }
      break; // Only use Tech Lead's comment
    }
  }

  // Read existing files and add to context - but keep it VERY brief
  let fileContext = '\n\n== EXISTING FILES (for reference ONLY - DO NOT re-analyze) ==\n';
  fileContext += 'QUICK IMPLEMENTATION GUIDE: Look at these files to understand the current structure.\n';
  fileContext += 'Then IMPLEMENT the required changes directly. DO NOT write analysis or summaries.\n';
  fileContext += 'Output code using FILE: path/to/file.ext format.\n\n';

  let hasFiles = false;
  for (const filePath of filesToRead) {
    const fullPath = path.join(WORKSPACE, filePath);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        // Truncate heavily - just show structure, not full content
        const truncated = truncate(content, 1500); // Reduced from 3000
        fileContext += `\n--- ${filePath} (current) ---\n${truncated}\n`;
        hasFiles = true;
      } catch (err) {
        console.log(`[proxy] Could not read ${filePath}: ${err.message}`);
      }
    }
  }

  if (!hasFiles) {
    fileContext += '(No existing files - you are creating new files)\n';
  }

  // Add strong implementation directive
  fileContext += '\n\n== IMPLEMENTATION INSTRUCTION ==\n';
  fileContext += 'DO NOT write analysis, summaries, or "let me check" messages.\n';
  fileContext += 'DO NOT describe what you will do - JUST DO IT.\n';
  fileContext += 'Output each file using: FILE: path/to/file.ext\\n```lang\\ncode\\n```\n';
  fileContext += 'Write ALL required files in ONE response.\n';

  return baseContext + fileContext;
}

/**
 * Validate that changes to critical files don't break existing functionality.
 * Returns { valid: boolean, reason?: string, preservedMethods?: string[] }.
 */
function validateCriticalFileChanges(filePath, oldContent, newContent) {
  // For store files (zustand), check that essential methods are preserved
  if (filePath.includes('/store/') || filePath.includes('store.')) {
    // Extract method names from old content
    const oldMethods = oldContent.match(/(\w+):\s*\([^)]*\)\s*=>/g) || [];
    const oldMethodNames = oldMethods.map(m => m.split(':')[0].trim());
    
    // Check if new content has the same methods
    const newMethods = newContent.match(/(\w+):\s*\([^)]*\)\s*=>/g) || [];
    const newMethodNames = newMethods.map(m => m.split(':')[0].trim());
    
    // Find removed methods
    const removedMethods = oldMethodNames.filter(m => !newMethodNames.includes(m));
    
    if (removedMethods.length > 0) {
      return {
        valid: false,
        reason: `Store file is removing required methods: ${removedMethods.join(', ')}. These methods may be used by other parts of the app.`
      };
    }
  }

  // For type files, check that essential interfaces are preserved
  if (filePath.includes('/types/') || filePath.includes('types.')) {
    const oldInterfaces = oldContent.match(/export\s+(?:interface|type)\s+(\w+)/g) || [];
    const oldInterfaceNames = oldInterfaces.map(i => i.split(/\s+/)[2]);
    
    const newInterfaces = newContent.match(/export\s+(?:interface|type)\s+(\w+)/g) || [];
    const newInterfaceNames = newInterfaces.map(i => i.split(/\s+/)[2]);
    
    const removedInterfaces = oldInterfaceNames.filter(i => !newInterfaceNames.includes(i));
    
    if (removedInterfaces.length > 0) {
      return {
        valid: false,
        reason: `Type file is removing exported types: ${removedInterfaces.join(', ')}. These types may be imported by other files.`
      };
    }
  }

  // For auth files, check that essential functions are preserved
  if (filePath.includes('/auth/') || filePath.includes('auth.')) {
    const essentialPatterns = [
      /export.*useRegister/,
      /export.*useLogin/,
      /export.*register/,
      /export.*login/,
    ];
    
    for (const pattern of essentialPatterns) {
      if (pattern.test(oldContent) && !pattern.test(newContent)) {
        return {
          valid: false,
          reason: `Auth file is removing essential exports. Check that all authentication functions are preserved.`
        };
      }
    }
  }

  return { valid: true };
}

function buildHeartbeatContext(context) {
  const parts = [];
  if (context.wakeReason) parts.push(`Wake reason: ${context.wakeReason}`);
  if (context.paperclipWorkspace?.cwd) {
    parts.push(`Workspace: ${context.paperclipWorkspace.cwd}`);
  }
  if (parts.length === 0) {
    parts.push(
      "This is a routine heartbeat check. Report your current status briefly."
    );
  }
  return parts.join("\n");
}

// ============================================================
// Artist Agent: deterministic Playwright feature recorder
// ============================================================

function getArtifactDir(issueId) {
  return path.join(SCREENSHOT_BASE, issueId.slice(0, 8));
}

function getIssueTexts(issue, comments) {
  const texts = [];
  if (issue?.title) texts.push(issue.title);
  if (issue?.description) texts.push(issue.description);
  for (const c of comments || []) {
    if (c?.body) texts.push(c.body);
  }
  return texts;
}

function normalizeArtistStep(step) {
  if (!step || typeof step !== "object") return null;
  const action = step.action || step.type;
  if (!action) return null;

  return {
    action,
    label: step.label || step.name || action,
    target: step.target ?? step.selector ?? step.url ?? null,
    selectors: Array.isArray(step.selectors) ? step.selectors : null,
    value: step.value ?? step.text ?? step.key ?? null,
    timeoutMs: step.timeoutMs || step.timeout || ARTIST_STEP_TIMEOUT_MS,
    optional: Boolean(step.optional),
  };
}

function parseArtistFlowFromText(text) {
  const blockRegex = /```(?:json|artist-flow)?\n([\s\S]*?)```/gi;
  let match;
  while ((match = blockRegex.exec(text)) !== null) {
    const parsed = safeJsonParse(match[1].trim());
    if (!parsed) continue;
    const flow = parsed.artistFlow || parsed.flow || parsed;
    if (!flow || !Array.isArray(flow.steps)) continue;

    return {
      name: flow.name || "custom-flow",
      startRoute: normalizeRoute(flow.startRoute || "/"),
      steps: flow.steps.map(normalizeArtistStep).filter(Boolean),
      source: "json",
    };
  }
  return null;
}

function buildFallbackArtistFlow(issue, comments) {
  const text = `${issue?.title || ""}\n${issue?.description || ""}\n${(comments || []).map(c => c.body || "").join("\n")}`.toLowerCase();

  if (/(item|product|inventory)/i.test(text)) {
    return {
      name: "items-flow",
      startRoute: "/items",
      source: "heuristic",
      steps: [
        { action: "goto", label: "Open items page", target: "/items" },
        {
          action: "click",
          label: "Open add item UI",
          selectors: [
            'button:has-text("Add Item")',
            'button:has-text("Add item")',
            'button:has-text("Add")',
            'button:has-text("New Item")',
            'button:has-text("New")',
            '[aria-label*="add" i]',
            '[data-testid*="add" i]',
          ],
          optional: true,
        },
        { action: "screenshot", label: "Record items feature state", optional: true },
      ].map(normalizeArtistStep),
    };
  }

  if (/(categor)/i.test(text)) {
    return {
      name: "categories-flow",
      startRoute: "/categories",
      source: "heuristic",
      steps: [
        { action: "goto", label: "Open categories page", target: "/categories" },
        {
          action: "click",
          label: "Open category UI",
          selectors: [
            'button:has-text("Add Category")',
            'button:has-text("Add")',
            'button:has-text("New Category")',
            'button:has-text("Edit")',
          ],
          optional: true,
        },
        { action: "screenshot", label: "Record categories feature state", optional: true },
      ].map(normalizeArtistStep),
    };
  }

  if (/(user|staff|team)/i.test(text)) {
    return {
      name: "users-flow",
      startRoute: "/users",
      source: "heuristic",
      steps: [
        { action: "goto", label: "Open users page", target: "/users" },
        {
          action: "click",
          label: "Open user invite/add UI",
          selectors: [
            'button:has-text("Invite")',
            'button:has-text("Add User")',
            'button:has-text("Add")',
            'button:has-text("New")',
          ],
          optional: true,
        },
        { action: "screenshot", label: "Record users feature state", optional: true },
      ].map(normalizeArtistStep),
    };
  }

  if (/(setting|config|preference)/i.test(text)) {
    return {
      name: "settings-flow",
      startRoute: "/settings",
      source: "heuristic",
      steps: [
        { action: "goto", label: "Open settings page", target: "/settings" },
        { action: "screenshot", label: "Record settings feature state", optional: true },
      ].map(normalizeArtistStep),
    };
  }

  if (/(shop|branding|theme|myshop)/i.test(text)) {
    return {
      name: "myshop-flow",
      startRoute: "/myshop",
      source: "heuristic",
      steps: [
        { action: "goto", label: "Open my shop page", target: "/myshop" },
        { action: "screenshot", label: "Record my shop feature state", optional: true },
      ].map(normalizeArtistStep),
    };
  }

  return {
    name: "smoke-flow",
    startRoute: "/",
    source: "fallback",
    steps: [
      { action: "goto", label: "Open dashboard", target: "/" },
      { action: "goto", label: "Open items page", target: "/items", optional: true },
      { action: "goto", label: "Open categories page", target: "/categories", optional: true },
      { action: "goto", label: "Open settings page", target: "/settings", optional: true },
      { action: "screenshot", label: "Record final UI state", optional: true },
    ].map(normalizeArtistStep),
  };
}

function resolveArtistFlow(issue, comments) {
  for (const text of getIssueTexts(issue, comments)) {
    const parsed = parseArtistFlowFromText(text);
    if (parsed) return parsed;
  }
  return buildFallbackArtistFlow(issue, comments);
}

async function startArtistDevServer(issueId) {
  const SCREENSHOT_DIR = getArtifactDir(issueId);
  ensureDir(SCREENSHOT_DIR);

  let devProcess = null;
  let serverReady = false;
  const serverLogs = [];

  try {
    await fetch(`http://localhost:${DEV_SERVER_PORT}`, { signal: AbortSignal.timeout(2000) });
    serverReady = true;
    console.log(`[proxy] Dev server already running on :${DEV_SERVER_PORT}`);
    return { devProcess: null, serverLogs, startedByUs: false };
  } catch {}

  console.log(`[proxy] Starting dev server for Artist feature recorder...`);
  const dashboardWebDir = path.join(WORKSPACE, "apps", "dashboard-web");
  const nextBin = path.join(WORKSPACE, "node_modules", ".bin", "next");
  devProcess = spawn(nextBin, ["dev", "-p", String(DEV_SERVER_PORT)], {
    cwd: dashboardWebDir,
    shell: true,
    stdio: "pipe",
    env: { ...process.env },
  });

  const handleLog = (type, chunk) => {
    const s = chunk.toString();
    serverLogs.push(`[${type}] ${s}`);
    if (s.includes("Ready") || s.includes("ready") || s.includes("compiled") || s.includes("localhost")) {
      serverReady = true;
    }
  };

  devProcess.stdout.on("data", (d) => handleLog("stdout", d));
  devProcess.stderr.on("data", (d) => handleLog("stderr", d));

  const startTime = Date.now();
  while (!serverReady && Date.now() - startTime < 60000) {
    await sleep(2000);
    try {
      await fetch(`http://localhost:${DEV_SERVER_PORT}`, { signal: AbortSignal.timeout(2000) });
      serverReady = true;
    } catch {}
  }

  if (!serverReady) {
    try { devProcess.kill(); } catch {}
    const errMsg = truncate(serverLogs.join("").slice(0, 1200) || "No error output", 1200);
    console.error(`[proxy] Dev server failed to start within 60s: ${errMsg}`);
    await postComment(issueId, AGENTS.artist, `_Feature recording failed: dev server did not start within 60s._\n\`\`\`\n${errMsg}\n\`\`\``);
    return null;
  }

  console.log(`[proxy] Dev server ready on :${DEV_SERVER_PORT}`);
  return { devProcess, serverLogs, startedByUs: true };
}

async function stopArtistDevServer(handle) {
  if (!handle?.startedByUs || !handle.devProcess) return;
  try {
    handle.devProcess.kill();
    console.log("[proxy] Dev server stopped");
  } catch {}
}

async function injectArtistAuth(page) {
  const fakeUser = {
    id: "artist-bot",
    first_name: "Artist",
    last_name: "Bot",
    email: "artist@shop-diary.local",
    role: "Admin",
    shopId: "artist-shop",
    shopName: "Artist Audit Shop",
    shopShortDesc: "Feature recording",
    shopColorTheme: "purple",
    shopAdminId: "artist-bot",
    shopLogo: "",
    created_at: new Date().toISOString(),
  };
  const fakeToken = "artist-feature-recorder-token";

  await page.waitForTimeout(3000);

  return page.evaluate((authData) => {
    const store = window.__USER_STORE__;
    if (!store || typeof store.getState !== "function") {
      return { success: false, reason: "window.__USER_STORE__ not found" };
    }
    const state = store.getState();
    if (typeof state.signInUser === "function") {
      state.signInUser({ user: authData.user, token: authData.token });
      return { success: true };
    }
    if (typeof store.setState === "function") {
      store.setState({ user: authData.user, token: authData.token });
      return { success: true, method: "setState" };
    }
    return { success: false, reason: "signInUser/setState missing" };
  }, { user: fakeUser, token: fakeToken });
}

async function getFirstMatchingLocator(page, selectors, timeoutMs = 2500) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: "visible", timeout: timeoutMs });
      return { locator, selector };
    } catch {}
  }
  return null;
}

class FeatureRecorder {
  constructor(issueId, flowName, artifactDir) {
    this.issueId = issueId;
    this.flowName = flowName;
    this.artifactDir = artifactDir;
    this.screenshotsDir = path.join(artifactDir, "screenshots");
    this.videoDir = path.join(artifactDir, "video");
    this.logsDir = path.join(artifactDir, "logs");
    this.eventsFile = path.join(artifactDir, "events.ndjson");
    this.runFile = path.join(artifactDir, "run.json");
    this.reportFile = path.join(artifactDir, "report.md");
    this.traceFile = path.join(artifactDir, "trace.zip");
    this.steps = [];
    this.console = [];
    this.pageErrors = [];
    this.requestFailures = [];
    this.navEvents = [];
    this.screenshotPaths = [];
    this.lastSignature = null;

    ensureDir(this.screenshotsDir);
    ensureDir(this.videoDir);
    ensureDir(this.logsDir);
  }

  attachPageListeners(page) {
    page.on("console", (msg) => {
      const item = {
        ts: new Date().toISOString(),
        type: msg.type(),
        text: msg.text(),
      };
      this.console.push(item);
      appendNdjson(path.join(this.logsDir, "console.ndjson"), item);
    });

    page.on("pageerror", (err) => {
      const item = {
        ts: new Date().toISOString(),
        message: err.message,
      };
      this.pageErrors.push(item);
      appendNdjson(path.join(this.logsDir, "pageerrors.ndjson"), item);
    });

    page.on("requestfailed", (req) => {
      const item = {
        ts: new Date().toISOString(),
        url: req.url(),
        method: req.method(),
        failure: req.failure()?.errorText || "unknown",
      };
      this.requestFailures.push(item);
      appendNdjson(path.join(this.logsDir, "requestfailures.ndjson"), item);
    });

    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      const item = {
        ts: new Date().toISOString(),
        url: frame.url(),
      };
      this.navEvents.push(item);
      appendNdjson(path.join(this.logsDir, "navigation.ndjson"), item);
    });
  }

  logStep(step) {
    this.steps.push(step);
    appendNdjson(this.eventsFile, step);
  }

  async computeSignature(page) {
    const url = page.url();
    const title = await page.title().catch(() => "");
    const heading = await page.locator("h1").first().textContent().catch(() => "");
    const body = await page.locator("body").innerText().catch(() => "");
    return `${url}::${title}::${heading || ""}::${body.slice(0, 800)}`;
  }

  async captureIfChanged(page, label) {
    const signature = await this.computeSignature(page);
    if (signature === this.lastSignature) return null;
    this.lastSignature = signature;
    return this.forceCapture(page, label);
  }

  async forceCapture(page, label) {
    const index = String(this.screenshotPaths.length + 1).padStart(3, "0");
    const filename = `${index}-${slugify(label)}.png`;
    const fullPath = path.join(this.screenshotsDir, filename);
    await page.screenshot({ path: fullPath, fullPage: true });
    this.screenshotPaths.push(fullPath);
    return fullPath;
  }

  writeSummary(meta) {
    const data = {
      issueId: this.issueId,
      flowName: this.flowName,
      screenshots: this.screenshotPaths,
      steps: this.steps,
      console: this.console,
      pageErrors: this.pageErrors,
      requestFailures: this.requestFailures,
      navEvents: this.navEvents,
      ...meta,
    };
    writeJson(this.runFile, data);
    return data;
  }
}

async function executeArtistStep(page, step, recorder, baseUrl) {
  const startedAt = new Date().toISOString();
  const beforeUrl = page.url();

  try {
    switch (step.action) {
      case "goto": {
        const url = step.target?.startsWith("http")
          ? step.target
          : `${baseUrl}${normalizeRoute(step.target || "/")}`;
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: step.timeoutMs || ARTIST_STEP_TIMEOUT_MS,
        });
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1200);
        break;
      }

      case "click": {
        const selectors = step.selectors || (step.target ? [step.target] : []);
        const found = await getFirstMatchingLocator(page, selectors, 3000);
        if (!found) {
          if (step.optional) {
            recorder.logStep({
              ts: new Date().toISOString(),
              label: step.label,
              action: step.action,
              status: "skipped",
              reason: "No matching click selector found",
              selectors,
            });
            return;
          }
          throw new Error(`No matching selector found for click: ${selectors.join(", ")}`);
        }
        await found.locator.click({ timeout: step.timeoutMs || ARTIST_STEP_TIMEOUT_MS });
        await page.waitForTimeout(1200);
        break;
      }

      case "fill": {
        const selectors = step.selectors || (step.target ? [step.target] : []);
        const found = await getFirstMatchingLocator(page, selectors, 3000);
        if (!found) {
          if (step.optional) {
            recorder.logStep({
              ts: new Date().toISOString(),
              label: step.label,
              action: step.action,
              status: "skipped",
              reason: "No matching fill selector found",
              selectors,
            });
            return;
          }
          throw new Error(`No matching selector found for fill: ${selectors.join(", ")}`);
        }
        await found.locator.fill(String(step.value || ""), {
          timeout: step.timeoutMs || ARTIST_STEP_TIMEOUT_MS,
        });
        await page.waitForTimeout(500);
        break;
      }

      case "press": {
        const selectors = step.selectors || (step.target ? [step.target] : []);
        const found = await getFirstMatchingLocator(page, selectors, 3000);
        if (!found) {
          if (step.optional) {
            recorder.logStep({
              ts: new Date().toISOString(),
              label: step.label,
              action: step.action,
              status: "skipped",
              reason: "No matching press selector found",
              selectors,
            });
            return;
          }
          throw new Error(`No matching selector found for press: ${selectors.join(", ")}`);
        }
        await found.locator.press(String(step.value || "Enter"), {
          timeout: step.timeoutMs || ARTIST_STEP_TIMEOUT_MS,
        });
        await page.waitForTimeout(800);
        break;
      }

      case "waitForText": {
        await page.getByText(String(step.value || ""), { exact: false }).waitFor({
          timeout: step.timeoutMs || ARTIST_STEP_TIMEOUT_MS,
        });
        break;
      }

      case "waitForSelector": {
        const selectors = step.selectors || (step.target ? [step.target] : []);
        const found = await getFirstMatchingLocator(page, selectors, step.timeoutMs || ARTIST_STEP_TIMEOUT_MS);
        if (!found && !step.optional) {
          throw new Error(`No selector became visible: ${selectors.join(", ")}`);
        }
        break;
      }

      case "wait": {
        await page.waitForTimeout(Number(step.value || step.timeoutMs || 1000));
        break;
      }

      case "screenshot": {
        const shot = await recorder.forceCapture(page, step.label);
        recorder.logStep({
          ts: new Date().toISOString(),
          label: step.label,
          action: step.action,
          status: "ok",
          screenshotPath: shot,
        });
        return;
      }

      default:
        if (step.optional) {
          recorder.logStep({
            ts: new Date().toISOString(),
            label: step.label,
            action: step.action,
            status: "skipped",
            reason: `Unknown action "${step.action}"`,
          });
          return;
        }
        throw new Error(`Unknown artist step action: ${step.action}`);
    }

    const screenshotPath = await recorder.captureIfChanged(page, step.label);
    recorder.logStep({
      ts: new Date().toISOString(),
      label: step.label,
      action: step.action,
      target: step.target || null,
      selectors: step.selectors || null,
      value: step.value || null,
      startedAt,
      finishedAt: new Date().toISOString(),
      beforeUrl,
      afterUrl: page.url(),
      status: "ok",
      screenshotPath,
    });
  } catch (err) {
    const screenshotPath = await recorder.forceCapture(page, `error-${step.label}`);
    recorder.logStep({
      ts: new Date().toISOString(),
      label: step.label,
      action: step.action,
      target: step.target || null,
      selectors: step.selectors || null,
      value: step.value || null,
      startedAt,
      finishedAt: new Date().toISOString(),
      beforeUrl,
      afterUrl: page.url(),
      status: step.optional ? "skipped" : "failed",
      error: err.message,
      screenshotPath,
    });

    if (!step.optional) throw err;
  }
}

function buildArtistReport(runData) {
  const failedSteps = runData.steps.filter((s) => s.status === "failed");
  const skippedSteps = runData.steps.filter((s) => s.status === "skipped");
  const okSteps = runData.steps.filter((s) => s.status === "ok");
  const topConsole = runData.console
    .filter((c) => c.type === "error" || c.type === "warning")
    .slice(0, 5);
  const topRequests = runData.requestFailures.slice(0, 5);

  const lines = [];
  lines.push("# Feature Execution Report");
  lines.push("");
  lines.push(`Result: ${runData.status.toUpperCase()}`);
  lines.push(`Flow: ${runData.flowName}`);
  lines.push(`Source: ${runData.flowSource}`);
  lines.push(`Branch: ${runData.branchName}`);
  lines.push(`Base URL: ${runData.baseUrl}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(`- Steps completed: ${okSteps.length}`);
  lines.push(`- Steps failed: ${failedSteps.length}`);
  lines.push(`- Steps skipped: ${skippedSteps.length}`);
  lines.push(`- Screenshots captured: ${runData.screenshots.length}`);
  lines.push(`- Console errors/warnings: ${topConsole.length}`);
  lines.push(`- Failed network requests: ${topRequests.length}`);
  lines.push("");

  lines.push("## Timeline");
  for (const step of runData.steps) {
    const icon = step.status === "ok" ? "PASS" : step.status === "failed" ? "FAIL" : "SKIP";
    const extra = step.error ? ` -- ${step.error}` : "";
    lines.push(`- ${icon} ${step.label}${extra}`);
  }
  lines.push("");

  if (topConsole.length > 0) {
    lines.push("## Console Findings");
    for (const item of topConsole) {
      lines.push(`- [${item.type}] ${truncate(item.text, 200)}`);
    }
    lines.push("");
  }

  if (topRequests.length > 0) {
    lines.push("## Failed Requests");
    for (const item of topRequests) {
      lines.push(`- ${item.method} ${item.url} -- ${item.failure}`);
    }
    lines.push("");
  }

  if (runData.screenshots.length > 0) {
    lines.push("## Screenshot Files");
    for (const filePath of runData.screenshots) {
      lines.push(`- ${filePath}`);
    }
    lines.push("");
  }

  lines.push("## Local Artifacts");
  lines.push(`- Video dir: ${runData.videoDir}`);
  lines.push(`- Trace: ${runData.tracePath}`);
  lines.push(`- Run JSON: ${runData.runFile}`);
  lines.push(`- Event log: ${runData.eventsFile}`);
  lines.push("");

  if (failedSteps.length > 0) {
    lines.push("## Highest Priority Findings");
    failedSteps.slice(0, 3).forEach((step, idx) => {
      lines.push(`${idx + 1}. ${step.label} failed`);
      if (step.error) lines.push(`   - Error: ${step.error}`);
      if (step.screenshotPath) lines.push(`   - Screenshot: ${step.screenshotPath}`);
    });
    lines.push("");
  }

  return lines.join("\n");
}

async function runArtistRecorder(issueId) {
  const artifactDir = getArtifactDir(issueId);
  ensureDir(artifactDir);

  const [issue, comments] = await Promise.all([
    getIssueDetails(issueId),
    getIssueComments(issueId),
  ]);
  if (!issue) throw new Error("Issue not found");

  const flow = resolveArtistFlow(issue, comments);
  const branchName = await getBranchName(issueId);
  const baseUrl = `http://localhost:${DEV_SERVER_PORT}`;
  const opts = { cwd: WORKSPACE, stdio: "pipe", timeout: 30000 };

  await postComment(
    issueId,
    AGENTS.artist,
    `_Starting feature recording on branch \`${branchName}\` using flow \`${flow.name}\` (${flow.source})._`
  );

  try {
    execSync(`git checkout ${branchName}`, opts);
    console.log(`[proxy] Artist: checked out ${branchName} for feature recording`);
  } catch (err) {
    throw new Error(`Could not checkout feature branch ${branchName}: ${err.message}`);
  }

  const serverHandle = await startArtistDevServer(issueId);
  if (!serverHandle) {
    try { execSync("git checkout master", opts); } catch {}
    return null;
  }

  const recorder = new FeatureRecorder(issueId, flow.name, artifactDir);
  let browser = null;
  let context = null;
  let page = null;
  let videoHandle = null;

  try {
    const { chromium } = require(path.join(WORKSPACE, "node_modules", "playwright"));
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: ARTIST_VIEWPORT,
      recordVideo: {
        dir: recorder.videoDir,
        size: ARTIST_VIEWPORT,
      },
    });

    await context.tracing.start({
      screenshots: true,
      snapshots: true,
    });

    page = await context.newPage();
    videoHandle = page.video();
    recorder.attachPageListeners(page);

    await page.goto(`${baseUrl}${normalizeRoute(flow.startRoute)}`, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    const authInjected = await injectArtistAuth(page);
    if (authInjected?.success) {
      console.log(`[proxy] Auth injection succeeded — Artist can now record authenticated pages`);
      await page.waitForTimeout(1000);
    } else {
      console.error(`[proxy] Auth injection FAILED: ${authInjected?.reason}`);
      recorder.logStep({
        ts: new Date().toISOString(),
        label: "Inject authenticated session",
        action: "auth",
        status: "failed",
        error: authInjected?.reason || "auth injection failed",
      });
    }

    await recorder.forceCapture(page, "initial-state");

    let failed = false;
    for (const step of flow.steps) {
      try {
        await executeArtistStep(page, step, recorder, baseUrl);
      } catch (err) {
        failed = true;
        console.error(`[proxy] Artist step failed: ${step.label}: ${err.message}`);
        break;
      }
    }

    await context.tracing.stop({ path: recorder.traceFile });
    await context.close();

    const videoPath = videoHandle ? await videoHandle.path().catch(() => null) : null;
    await browser.close();
    await stopArtistDevServer(serverHandle);

    const runData = recorder.writeSummary({
      issueId,
      status: failed ? "failed" : "passed",
      flowName: flow.name,
      flowSource: flow.source,
      branchName,
      baseUrl,
      videoPath,
      videoDir: recorder.videoDir,
      tracePath: recorder.traceFile,
      runFile: recorder.runFile,
      reportFile: recorder.reportFile,
      eventsFile: recorder.eventsFile,
      serverLogs: serverHandle.serverLogs,
    });

    const report = buildArtistReport(runData);
    fs.writeFileSync(recorder.reportFile, report);

    try { execSync("git checkout master", opts); } catch {}

    return { ...runData, report };
  } catch (err) {
    console.error(`[proxy] Artist recorder error:`, err.message);

    try {
      if (context) {
        await context.tracing.stop({ path: recorder.traceFile }).catch(() => {});
        await context.close().catch(() => {});
      }
    } catch {}

    try {
      if (browser) {
        await browser.close().catch(() => {});
      }
    } catch {}

    await stopArtistDevServer(serverHandle);

    const runData = recorder.writeSummary({
      issueId,
      status: "failed",
      flowName: flow.name,
      flowSource: flow.source,
      branchName,
      baseUrl,
      videoPath: null,
      videoDir: recorder.videoDir,
      tracePath: recorder.traceFile,
      runFile: recorder.runFile,
      reportFile: recorder.reportFile,
      eventsFile: recorder.eventsFile,
      fatalError: err.message,
      serverLogs: serverHandle.serverLogs,
    });

    const report = buildArtistReport(runData) + `\n\n## Fatal Error\n- ${err.message}\n`;
    fs.writeFileSync(recorder.reportFile, report);

    try { execSync("git checkout master", opts); } catch {}

    return { ...runData, report };
  }
}

async function runArtistStage(issueId) {
  if (artistProcessingLock[issueId]) {
    console.log(`[proxy] Skipping duplicate Artist run for ${issueId.slice(0, 8)} (already processing)`);
    return;
  }

  artistProcessingLock[issueId] = true;
  try {
    const result = await runArtistRecorder(issueId);
    if (!result) return;

    await postComment(issueId, AGENTS.artist, result.report);

    if (result.status === "passed") {
      await postComment(
        issueId,
        AGENTS.artist,
        `_Feature recording complete. Flow \`${result.flowName}\` passed visually. Moving issue to in_review._`
      );
      // Move to in_review - pipeline complete
      await patchIssue(issueId, { status: "in_review", assigneeAgentId: null });
      console.log(`[proxy] Issue ${issueId.slice(0, 8)} moved to in_review (pipeline complete)`);
    } else {
      await postComment(
        issueId,
        AGENTS.artist,
        `_Feature recording complete with failures. Assigning back to Local Builder with the attached visual execution report and artifacts._`
      );
      await patchIssue(issueId, { assigneeAgentId: AGENTS["local builder"] });
      console.log(`[proxy] Auto-assigned back to Local Builder after Artist recording`);
    }
  } catch (err) {
    console.error(`[proxy] Artist stage failed:`, err.message);
    await postComment(issueId, AGENTS.artist, `_Artist feature recorder failed: ${err.message}_`);
    await patchIssue(issueId, { assigneeAgentId: AGENTS["local builder"] });
  } finally {
    artistProcessingLock[issueId] = false;
  }
}

function createProxy(proxyPort, ollamaPort) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end("Method not allowed");
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString();

    let parsedBody;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      res.writeHead(400);
      res.end("Invalid JSON");
      return;
    }

    let issueId = extractIssueId(parsedBody);
    const agentId = extractAgentId(parsedBody);
    const agentName = await getAgentName(agentId);

    // If no issue in payload, check if this agent has an assigned issue
    if (!issueId && agentId) {
      const assignedIssueId = await findAssignedIssue(agentId);
      if (assignedIssueId) {
        issueId = assignedIssueId;
        console.log(`[proxy] Auto-resolved issue for ${agentName}: ${issueId.slice(0, 8)}`);
      }
    }

    // Block disabled agents
    if (BLOCKED_AGENTS.has(agentId)) {
      console.log(
        `[proxy:${proxyPort}] BLOCKED ${agentName} (disabled agent)`
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          message: {
            role: "assistant",
            content: "_Agent is currently disabled._",
          },
        })
      );
      return;
    }

    // Guard: skip processing if issue is already completed (in_review/done)
    // This prevents duplicate wakeups from running agents on finished issues
    if (issueId) {
      const issueState = await getIssueDetails(issueId);
      if (issueState && (issueState.status === "in_review" || issueState.status === "done" || issueState.status === "cancelled")) {
        console.log(`[proxy] Skipping ${agentName} — issue ${issueId.slice(0, 8)} is ${issueState.status}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          message: { role: "assistant", content: `_Issue is ${issueState.status}, no action needed._` },
        }));
        return;
      }
    }

    // Artist bypasses Ollama and runs deterministic recorder
    if (issueId && agentId === AGENTS.artist) {
      console.log(`[proxy:${proxyPort}] ${agentName} -> feature recorder | issue=${issueId.slice(0, 8)}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        message: {
          role: "assistant",
          content: "_Artist feature recorder started._",
        },
      }));

      setImmediate(async () => {
        await runArtistStage(issueId);
      });
      return;
    }

    // Build Ollama payload
    const ollamaPayload = {
      model: parsedBody.model,
      stream: parsedBody.stream ?? false,
      messages: [...(parsedBody.messages || [])],
    };

    // Enrich with issue context or heartbeat context
    if (issueId) {
      // Local Builder gets enhanced context with existing file contents
      const issueContext = agentId === AGENTS["local builder"]
        ? await buildLocalBuilderContext(issueId, agentId)
        : await buildIssueContext(issueId, agentId);
      if (issueContext) {
        ollamaPayload.messages.push({
          role: "user",
          content: issueContext,
        });
      }
    } else if (parsedBody.context) {
      const heartbeatMsg = buildHeartbeatContext(parsedBody.context);
      ollamaPayload.messages.push({ role: "user", content: heartbeatMsg });
    }

    console.log(
      `[proxy:${proxyPort}] ${agentName} -> ollama:${ollamaPort} | model=${ollamaPayload.model} | issue=${issueId?.slice(0, 8) || "none"} | msgs=${ollamaPayload.messages.length}`
    );

    try {
      const ollamaRes = await fetch(
        `http://127.0.0.1:${ollamaPort}/api/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ollamaPayload),
        }
      );

      const ollamaData = await ollamaRes.text();

      res.writeHead(ollamaRes.status, {
        "Content-Type": "application/json",
      });
      res.end(ollamaData);

      // Post LLM output as comment and handle delegation
      if (issueId) {
        try {
          const parsed = JSON.parse(ollamaData);
          const content =
            parsed.message?.content || parsed.response || "";
          console.log(`[proxy] LLM response keys: ${Object.keys(parsed).join(", ")}`);
          console.log(`[proxy] LLM message keys: ${parsed.message ? Object.keys(parsed.message).join(", ") : "no message"}`);
          if (content.trim()) {
            await postComment(issueId, agentId, content.trim());
            // Detect delegation and reassign via API (triggers auto-wakeup)
            console.log(`[proxy] Checking delegation for ${agentId}, content length: ${content.length}`);
            await detectAndDelegate(issueId, agentId, content);

            // Local Builder: extract code blocks, write files, commit (no PR yet)
            console.log(`[proxy] Checking if agent ${agentId} is Local Builder ${AGENTS["local builder"]}: ${agentId === AGENTS["local builder"]}`);
            if (agentId === AGENTS["local builder"]) {
              console.log(`[proxy] Local Builder detected! Processing content...`);
              // Prevent concurrent processing of same issue (Paperclip can wake LB multiple times)
              if (issueProcessingLock[issueId]) {
                console.log(`[proxy] Skipping duplicate Local Builder run for ${issueId.slice(0, 8)} (already processing)`);
              } else {
                issueProcessingLock[issueId] = true;
                try {
                  console.log(`[proxy] Calling applyCodeBlocks with content length: ${content.length}`);
                  const { written: writtenFiles, fileContents } = applyCodeBlocks(content);
                  console.log(`[proxy] applyCodeBlocks returned ${writtenFiles.length} files`);
                  if (writtenFiles.length > 0) {
                    // Track pass count (survives restarts by checking git branch)
                    if (!issueBuilderPasses[issueId]) {
                      // Check if branch already has commits (means pass 1 already happened)
                      try {
                        const branchName = await getBranchName(issueId);
                        execSync(`git rev-parse --verify ${branchName}`, { cwd: WORKSPACE, stdio: "pipe" });
                        // Branch exists — this is at least pass 2
                        issueBuilderPasses[issueId] = 1;
                        console.log(`[proxy] Detected existing branch ${branchName}, setting pass count to 1`);
                      } catch {
                        issueBuilderPasses[issueId] = 0;
                      }
                    }
                    issueBuilderPasses[issueId]++;
                    const pass = issueBuilderPasses[issueId];
                    console.log(`[proxy] Local Builder wrote ${writtenFiles.length} files (pass ${pass})`);

                    // Commit and push (no PR)
                    await commitAndPush(issueId, writtenFiles, fileContents);

                    if (pass >= 2) {
                      // Post-feedback revision: send to Reviewer for final approval
                      console.log(`[proxy] Pass ${pass}: Sending to Reviewer for final approval...`);
                      try {
                        await fetch(`${PAPERCLIP_API}/api/issues/${issueId}`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ assigneeAgentId: AGENTS.reviewer }),
                        });
                        console.log(`[proxy] Auto-assigned to Reviewer for final approval`);
                      } catch (err) {
                        console.error(`[proxy] Failed to trigger Reviewer:`, err.message);
                      }
                    } else {
                      // First pass: send to Reviewer for code review (no PR)
                      console.log(`[proxy] Pass ${pass}: Sending to Reviewer for initial review...`);
                      try {
                        await fetch(`${PAPERCLIP_API}/api/issues/${issueId}`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ assigneeAgentId: AGENTS.reviewer }),
                        });
                        console.log(`[proxy] Auto-assigned to Reviewer for code review`);
                      } catch (err) {
                        console.error(`[proxy] Failed to trigger Reviewer:`, err.message);
                      }
                    }
                  }
                } finally {
                  issueProcessingLock[issueId] = false;
                }
              } // end else (not locked)
            }

            // Strategist/Sentinel/Deployer/Reviewer: execute bash commands
            const commandsWereExecuted = await executeBashBlocks(issueId, agentId, content);

            // After executing bash commands, re-prompt the agent by re-assigning the issue
            // This triggers a fresh webhook call with updated context (including command results in comments)
            if (commandsWereExecuted && agentId !== AGENTS["local builder"]) {
              console.log(`[proxy] Commands executed - will re-assign to ${AGENT_NAMES[agentId] || "agent"} for follow-up analysis...`);
              // Re-assign to same agent to trigger Paperclip webhook with fresh context
              // Note: This may be deduped by Paperclip if no actual change, so we add a noop context update
              try {
                await fetch(`${PAPERCLIP_API}/api/issues/${issueId}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ 
                    assigneeAgentId: agentId,
                    // Include a context update to ensure webhook is triggered
                    description: (await getIssueDetails(issueId))?.description || ""
                  }),
                });
                console.log(`[proxy] Re-assigned issue ${issueId.slice(0, 8)} to ${AGENT_NAMES[agentId]} for follow-up`);
              } catch (err) {
                console.error(`[proxy] Failed to re-assign for follow-up:`, err.message);
              }
            }

            // Reviewer: validate changes and approve/reject before PR creation
            if (agentId === AGENTS.reviewer) {
              // Reviewer should analyze the code changes and either approve or send back to Local Builder
              // The Reviewer's response content will indicate approval or rejection
              const reviewApproved = content.toLowerCase().includes('approved') || 
                                     content.toLowerCase().includes('looks good') ||
                                     content.toLowerCase().includes('lgtm') ||
                                     content.toLowerCase().includes('no issues') ||
                                     content.toLowerCase().includes('ready for pr');
              
              if (reviewApproved) {
                console.log(`[proxy] Reviewer APPROVED changes for ${issueId.slice(0, 8)}`);
                
                // Create PR after reviewer approval
                try {
                  await createPullRequest(issueId);
                  console.log(`[proxy] PR created after Reviewer approval`);
                } catch (prErr) {
                  console.error(`[proxy] Failed to create PR:`, prErr.message);
                  await postComment(issueId, null, `_Reviewer approved but PR creation failed: ${prErr.message}_`);
                }
                
                // Trigger Artist for visual audit after PR creation
                try {
                  await fetch(`${PAPERCLIP_API}/api/issues/${issueId}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ assigneeAgentId: AGENTS.artist }),
                  });
                  console.log(`[proxy] Auto-assigned to Artist for feature recording`);
                } catch (err) {
                  console.error(`[proxy] Failed to trigger Artist:`, err.message);
                }
              } else {
                console.log(`[proxy] Reviewer found issues - sending back to Local Builder`);
                // Send back to Local Builder for fixes
                try {
                  await fetch(`${PAPERCLIP_API}/api/issues/${issueId}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ assigneeAgentId: AGENTS["local builder"] }),
                  });
                  console.log(`[proxy] Sent back to Local Builder for fixes`);
                } catch (err) {
                  console.error(`[proxy] Failed to send back to Local Builder:`, err.message);
                }
              }
            }
          } else {
            await postComment(
              issueId,
              agentId,
              "_Agent completed run but produced no text output._"
            );
          }
        } catch {
          await postComment(
            issueId,
            agentId,
            "_Agent run completed. Response could not be parsed._"
          );
        }
      }
    } catch (err) {
      console.error(
        `[proxy:${proxyPort}] ${agentName} Ollama error:`,
        err.message
      );
      if (issueId) {
        await postComment(
          issueId,
          agentId,
          `_Agent run failed: ${err.message}_`
        );
      }
      res.writeHead(502);
      res.end(
        JSON.stringify({ error: `Ollama unreachable: ${err.message}` })
      );
    }
  });

  server.listen(proxyPort, "127.0.0.1", () => {
    console.log(`[proxy] :${proxyPort} -> ollama:${ollamaPort}`);
  });
  return server;
}

// Start background issue assignment checker
async function checkAssignedIssues() {
  try {
    const res = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/issues`);
    if (!res.ok) return;
    
    const data = await res.json();
    const issues = Array.isArray(data) ? data : (data.issues || data.data || []);
    
    // Find todo/in_progress issues assigned to agents
    const assignedIssues = issues.filter(
      i => (i.status === 'todo' || i.status === 'in_progress') && i.assigneeAgentId
    );
    
    for (const issue of assignedIssues) {
      const agentId = issue.assigneeAgentId;
      const agentName = AGENT_NAMES[agentId] || 'unknown';
      
      // Skip if agent is blocked or is coder-remote
      if (BLOCKED_AGENTS.has(agentId)) continue;
      
      // Check if agent has a recent run for this issue (within 5 minutes)
      const recentRunKey = `${agentId}:${issue.id}`;
      if (recentAgentRuns.has(recentRunKey)) {
        const lastRun = recentAgentRuns.get(recentRunKey);
        if (Date.now() - lastRun < 300000) continue; // 5 min cooldown
      }
      
      // Trigger agent wakeup via issue reassignment (triggers webhook)
      console.log(`[proxy] Background check: ${agentName} has assigned issue ${issue.identifier || issue.id.slice(0, 8)}`);
      
      // Re-assign to same agent to trigger webhook
      try {
        await fetch(`${PAPERCLIP_API}/api/issues/${issue.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            assigneeAgentId: agentId,
            // Add metadata update to ensure webhook fires
            priority: issue.priority || 'medium'
          }),
        });
        recentAgentRuns.set(recentRunKey, Date.now());
        console.log(`[proxy] Triggered wakeup for ${agentName} on ${issue.identifier || issue.id.slice(0, 8)}`);
      } catch (err) {
        console.log(`[proxy] Failed to trigger ${agentName}: ${err.message}`);
      }
    }
  } catch (err) {
    // Silent fail - don't spam logs
  }
}

// Track recent agent runs to prevent spam
const recentAgentRuns = new Map();

// Run background checker every 60 seconds
setInterval(() => {
  checkAssignedIssues().catch(() => {});
}, 60000);

// Run immediately on startup
setTimeout(() => {
  checkAssignedIssues().catch(() => {});
}, 5000);

for (const [proxyPort, ollamaPort] of Object.entries(PROXY_MAP)) {
  createProxy(parseInt(proxyPort), ollamaPort);
}
console.log("[proxy] All proxies started.");