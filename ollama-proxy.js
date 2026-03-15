/**
 * Ollama Proxy for Paperclip (v4)
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
 *
 * All agents -> single GPU Ollama instance:
 *   3201 (proxy) -> 11434 (Ollama GPU)
 *   Ollama queues requests internally -- agents wait their turn
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const WORKSPACE = "C:\\Users\\dinga\\Projects\\shop-diary-v2";
const GH_CLI = "C:\\Program Files\\GitHub CLI\\gh";

const PAPERCLIP_API = "http://127.0.0.1:3100";

const PROXY_MAP = {
  3201: 11434,
};

// Agent IDs
const AGENTS = {
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

// Valid delegation paths (org chart)
const DELEGATION_RULES = {
  [AGENTS.strategist]: [AGENTS["tech lead"], AGENTS.reviewer, AGENTS.sentinel, AGENTS.artist],
  [AGENTS["tech lead"]]: [AGENTS["local builder"]],
  [AGENTS.reviewer]: [AGENTS.artist],
  [AGENTS.sentinel]: [AGENTS.deployer],
};

// Agent API keys (Bearer tokens) for authenticated comment posting
const AGENT_KEYS = {
  [AGENTS.strategist]: "pcp_48d784f6edd3a907e7700cda9f93e36fc0d1030f4a6b6d04",
  [AGENTS["tech lead"]]: "pcp_ef721504b998e79742f272ad196be3952c28d5921dc4ba9a",
  [AGENTS["local builder"]]: "pcp_0fbcdff3e8a50df48ab7c94cd3f4409cd492b6eb84c683d8",
  [AGENTS.reviewer]: "pcp_650990c0932107838084b2adaf47fdbfb9407c649243211e",
  [AGENTS.sentinel]: "pcp_268a568963f01698e27a232c9b911d96fa3504b214232b97",
  [AGENTS.deployer]: "pcp_ad33d0ec65c082f7b46feef3233872548ac64b606e0e7541",
  [AGENTS.artist]: "pcp_6b6711a3a014c59c92416ec479077557a021087ba08bc280",
};

// Blocked agents (disabled, no API key, etc.)
const BLOCKED_AGENTS = new Set([AGENTS["coder remote"]]);

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

// Cache agent names from API (for comment history display)
const agentNameCache = {};
// Pre-populate from our known map
for (const [name, id] of Object.entries(AGENTS)) {
  agentNameCache[id] = name.charAt(0).toUpperCase() + name.slice(1);
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

const COMPANY_ID = "ac5c469b-1f81-4f1f-9061-1dd9033ec831";

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
        await new Promise(r => setTimeout(r, 2000 * attempt));
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
  if (!allowedTargets) return; // leaf agent, no delegation

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
  // LLMs use varied phrasing: "delegated to Tech Lead", "Agent: Tech Lead",
  // "assigned to Local Builder", "handing off to Reviewer", etc.
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

  if (found.length === 0) return;

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
  AGENTS.artist,
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
 * Extract code blocks with file paths from LLM output and write them to disk.
 * Returns array of written file paths (relative to workspace).
 */
function applyCodeBlocks(content) {
  const written = [];
  const fileContents = {}; // path -> content (for branch-safe commits)

  // Debug: log content stats to help diagnose extraction failures
  console.log(`[proxy] applyCodeBlocks: content length=${content.length}, has FILE:=${content.includes("FILE:")}, backticks=${(content.match(/```/g) || []).length}`);

  // Match FILE: path before code block, OR // path or -- path as first line inside code block
  // Pattern 1: FILE: path/to/file.ext\n```lang\ncode\n```
  const fileBeforeBlock = /FILE:\s*([\w./\\-]+\.\w+)\s*\n```[^\n]*\n([\s\S]*?)```/g;
  // Pattern 2: ```lang\n// path/to/file.ext\ncode\n```
  const fileInsideBlock = /```[^\n]*\n(?:\/\/|--|#)\s*([\w./\\-]+\.\w+)\s*\n([\s\S]*?)```/g;

  for (const blockRegex of [fileBeforeBlock, fileInsideBlock]) {
    let match;
    while ((match = blockRegex.exec(content)) !== null) {
      let filePath = match[1].trim().replace(/`/g, "");
      const code = match[2];

      // Skip if already written by a previous pattern
      if (written.includes(filePath)) continue;

      // Must look like a real file path (has a slash separator)
      if (!filePath.includes("/") && !filePath.includes("\\")) continue;

      // Safety: reject absolute paths and traversal
      if (path.isAbsolute(filePath) || filePath.includes("..")) {
        console.log(`[proxy] Rejected unsafe path: ${filePath}`);
        continue;
      }

      const fullPath = path.join(WORKSPACE, filePath);
      if (!path.resolve(fullPath).startsWith(path.resolve(WORKSPACE))) {
        console.log(`[proxy] Path escapes workspace: ${filePath}`);
        continue;
      }

      written.push(filePath);
      fileContents[filePath] = code;
      console.log(`[proxy] Extracted file: ${filePath}`);
    }
  }
  return { written, fileContents };
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
    execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, opts);
    console.log(`[proxy] Committed: ${commitMsg}`);

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
      `_Code committed to branch \`${branchName}\` (pass ${pass})_\n\nFiles:\n${files.map(f => "- \`" + f + "\`").join("\n")}`
    );

    // Run build validation on the branch
    console.log(`[proxy] Running build validation on branch ${branchName}...`);
    try {
      execSync("yarn build", { ...opts, timeout: 120000 });
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

    // Commit screenshots to the branch if they exist
    const screenshotFiles = [];
    const screenshotDir = path.join(WORKSPACE, ".screenshots");
    if (fs.existsSync(screenshotDir)) {
      const pngs = fs.readdirSync(screenshotDir).filter(f => f.endsWith(".png"));
      if (pngs.length > 0) {
        // Copy screenshots into a PR-visible directory
        const prScreenshotDir = path.join(WORKSPACE, "docs", "screenshots", identifier.toLowerCase());
        fs.mkdirSync(prScreenshotDir, { recursive: true });
        for (const png of pngs) {
          fs.copyFileSync(path.join(screenshotDir, png), path.join(prScreenshotDir, png));
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
    }

    // Switch back to master
    try { execSync("git checkout master", opts); } catch {}

    // Build PR body with screenshot images
    const GITHUB_REPO = "jeremiahdingal/shop-diary-v2";
    let prBody = `Auto-generated from issue ${identifier}\\n\\n`;
    prBody += `## Changes\\n(see commits on branch)\\n\\n`;

    if (screenshotFiles.length > 0) {
      prBody += `## Screenshots (Artist Visual Audit)\\n\\n`;
      for (const f of screenshotFiles) {
        const routeName = path.basename(f, ".png").replace(/^_/, "/").replace(/_/g, "/");
        const rawUrl = `https://github.com/${GITHUB_REPO}/blob/${branchName}/${f}?raw=true`;
        prBody += `### \`${routeName}\`\\n![${routeName}](${rawUrl})\\n\\n`;
      }
    }

    // Create PR (explicit --head so gh doesn't use current branch which is master)
    const prOutput = execSync(
      `"${GH_CLI}" pr create --head "${branchName}" --title "${commitMsg.replace(/"/g, '\\"')}" --body "${prBody}"`,
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
 */
async function executeBashBlocks(issueId, agentId, content) {
  if (!BASH_AGENTS.has(agentId)) return;

  const bashRegex = /```(?:bash|shell|sh)\n([\s\S]*?)```/g;
  let match;
  while ((match = bashRegex.exec(content)) !== null) {
    const command = match[1].trim();
    if (!command) continue;

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
    }
  }
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

  // Add assignment context so the agent knows its role
  const assignedBy = issue.assigneeAgentId !== currentAgentId
    ? "the system"
    : null;

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
// Artist Agent: Playwright Screenshots + Vision Analysis
// ============================================================

const SCREENSHOT_ROUTES = [
  "/",
  "/items",
  "/categories",
  "/myshop",
  "/settings",
  "/users",
];

const SCREENSHOT_DIR = path.join(WORKSPACE, ".screenshots");

/**
 * Start the Next.js dev server, take screenshots of all routes, return base64 images.
 */
async function captureScreenshots(issueId) {
  const { spawn } = require("child_process");

  // Ensure screenshot dir exists
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // Check if dev server is already running on port 3000
  let devProcess = null;
  let port = 3000;
  let serverReady = false;

  try {
    const checkRes = await fetch(`http://localhost:${port}`);
    serverReady = true;
    console.log(`[proxy] Dev server already running on :${port}`);
  } catch {
    // Start dev server (run next binary directly to avoid %PORT% issue in turbo scripts)
    console.log(`[proxy] Starting dev server for screenshots...`);
    const dashboardWebDir = path.join(WORKSPACE, "apps", "dashboard-web");
    const nextBin = path.join(WORKSPACE, "node_modules", ".bin", "next");
    devProcess = spawn(nextBin, ["dev", "-p", String(port)], {
      cwd: dashboardWebDir,
      shell: true,
      stdio: "pipe",
      env: { ...process.env },
    });

    devProcess.stdout.on("data", (d) => {
      const s = d.toString();
      if (s.includes("Ready") || s.includes("ready") || s.includes("compiled") || s.includes("localhost")) {
        serverReady = true;
      }
    });
    devProcess.stderr.on("data", (d) => {
      const s = d.toString();
      if (s.includes("Ready") || s.includes("ready") || s.includes("compiled") || s.includes("localhost")) {
        serverReady = true;
      }
    });

    // Wait up to 60s for server ready
    const startTime = Date.now();
    while (!serverReady && Date.now() - startTime < 60000) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const checkRes = await fetch(`http://localhost:${port}`);
        serverReady = true;
      } catch {}
    }

    if (!serverReady) {
      if (devProcess) {
        const stderr = [];
        devProcess.stderr.on("data", d => stderr.push(d.toString()));
        devProcess.kill();
        const errMsg = stderr.join("").slice(0, 500) || "No error output";
        console.error(`[proxy] Dev server failed to start within 60s: ${errMsg}`);
        await postComment(issueId, AGENTS.artist, `_Screenshot capture failed: dev server did not start within 60s._\n\`\`\`\n${errMsg}\n\`\`\``);
      }
      return [];
    }
    console.log(`[proxy] Dev server ready on :${port}`);
  }

  const screenshots = [];

  try {
    // Launch Playwright (installed in workspace, not proxy dir)
    const { chromium } = require(path.join(WORKSPACE, "node_modules", "playwright"));
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

    // Inject auth into localStorage so AuthGuard doesn't block us
    // Navigate to origin first (localStorage is per-origin)
    const authPage = await context.newPage();
    await authPage.goto(`http://localhost:${port}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await authPage.evaluate(() => {
      const fakeAuth = {
        state: {
          user: {
            id: "artist-bot",
            first_name: "Artist",
            last_name: "Bot",
            email: "artist@shop-diary.local",
            role: "Admin",
            shopId: "artist-shop",
            shopName: "Artist Audit Shop",
            shopShortDesc: "Visual audit",
            shopColorTheme: "purple",
            shopAdminId: "artist-bot",
            shopLogo: "",
            created_at: new Date().toISOString(),
          },
          token: "artist-visual-audit-token",
        },
        version: 0,
      };
      localStorage.setItem("user-storage", JSON.stringify(fakeAuth));
    });
    await authPage.close();
    console.log(`[proxy] Injected auth into localStorage for screenshots`);

    for (const route of SCREENSHOT_ROUTES) {
      try {
        const page = await context.newPage();
        await page.goto(`http://localhost:${port}${route}`, {
          waitUntil: "networkidle",
          timeout: 15000,
        });
        // Wait a beat for animations/hydration
        await page.waitForTimeout(1000);

        const screenshotPath = path.join(SCREENSHOT_DIR, `${route.replace(/\//g, "_") || "_root"}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });

        const base64 = fs.readFileSync(screenshotPath).toString("base64");
        screenshots.push({ route, base64 });
        console.log(`[proxy] Screenshot: ${route} (${Math.round(base64.length / 1024)}KB)`);
        await page.close();
      } catch (err) {
        console.error(`[proxy] Screenshot failed for ${route}:`, err.message);
        screenshots.push({ route, error: err.message });
      }
    }

    await browser.close();
  } catch (err) {
    console.error("[proxy] Playwright error:", err.message);
    await postComment(issueId, AGENTS.artist, `_Screenshot capture failed: ${err.message}_`);
  }

  // Kill dev server if we started it
  if (devProcess) {
    devProcess.kill();
    console.log("[proxy] Dev server stopped");
  }

  return screenshots;
}

/**
 * Send each screenshot to the vision model for analysis.
 * Posts results as comments on the issue.
 */
async function analyzeScreenshots(issueId, screenshots) {
  if (screenshots.length === 0) {
    await postComment(issueId, AGENTS.artist, "_No screenshots were captured. Check if the app builds and runs._");
    return;
  }

  const VISION_MODEL = "llama3.2-vision:11b";
  const ollamaUrl = "http://127.0.0.1:11434/api/chat";

  await postComment(
    issueId,
    AGENTS.artist,
    `# Visual Audit Report\n_Analyzing ${screenshots.length} screens with ${VISION_MODEL}..._`
  );

  let analyzed = 0;
  let errors = 0;

  for (const shot of screenshots) {
    if (shot.error) {
      await postComment(issueId, AGENTS.artist,
        sanitizeForWin1252(`## ${shot.route}\n**Screenshot failed:** ${shot.error}`)
      );
      errors++;
      continue;
    }

    try {
      console.log(`[proxy] Vision analyzing: ${shot.route}...`);
      const visionRes = await fetch(ollamaUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: VISION_MODEL,
          stream: false,
          messages: [
            {
              role: "user",
              content:
                `You are a UI/UX expert auditing a POS (point-of-sale) dashboard app built with React Native + Next.js. ` +
                `This is a screenshot of the "${shot.route}" page. Analyze it for:\n` +
                `1. Layout quality and visual hierarchy\n` +
                `2. Color harmony and contrast (WCAG AA compliance)\n` +
                `3. Typography consistency\n` +
                `4. Spacing and alignment\n` +
                `5. Component consistency\n` +
                `6. Modern UI/UX best practices\n\n` +
                `Score it out of 10 and provide specific, actionable improvements. ` +
                `Be concise -- max 200 words per screen.`,
              images: [shot.base64],
            },
          ],
        }),
        signal: AbortSignal.timeout(300000), // 5 min per screenshot
      });

      if (visionRes.ok) {
        const visionData = await visionRes.json();
        const analysis = visionData?.message?.content || "_No analysis produced._";
        // Post each screen's analysis immediately as its own comment
        await postComment(issueId, AGENTS.artist,
          sanitizeForWin1252(`## ${shot.route}\n${analysis}`)
        );
        analyzed++;
        console.log(`[proxy] Vision done: ${shot.route}`);
      } else {
        const errText = await visionRes.text().catch(() => "");
        await postComment(issueId, AGENTS.artist,
          sanitizeForWin1252(`## ${shot.route}\n**Vision error:** ${visionRes.status} ${errText.slice(0, 200)}`)
        );
        errors++;
        console.error(`[proxy] Vision error for ${shot.route}: ${visionRes.status}`);
      }
    } catch (err) {
      console.error(`[proxy] Vision error for ${shot.route}:`, err.message);
      await postComment(issueId, AGENTS.artist,
        sanitizeForWin1252(`## ${shot.route}\n**Vision error:** ${err.message}`)
      );
      errors++;
    }
  }

  console.log(`[proxy] Visual audit complete: ${analyzed} analyzed, ${errors} errors out of ${screenshots.length} screens`);
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

    // Build Ollama payload
    const ollamaPayload = {
      model: parsedBody.model,
      stream: parsedBody.stream ?? false,
      messages: [...(parsedBody.messages || [])],
    };

    // Enrich with issue context or heartbeat context
    if (issueId) {
      const issueContext = await buildIssueContext(issueId, agentId);
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
          if (content.trim()) {
            await postComment(issueId, agentId, content.trim());
            // Detect delegation and reassign via API (triggers auto-wakeup)
            await detectAndDelegate(issueId, agentId, content);

            // Local Builder: extract code blocks, write files, commit (no PR yet)
            if (agentId === AGENTS["local builder"]) {
              // Prevent concurrent processing of same issue (Paperclip can wake LB multiple times)
              if (issueProcessingLock[issueId]) {
                console.log(`[proxy] Skipping duplicate Local Builder run for ${issueId.slice(0, 8)} (already processing)`);
              } else {
              issueProcessingLock[issueId] = true;
              try {
              const { written: writtenFiles, fileContents } = applyCodeBlocks(content);
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
                  // Post-feedback revision: create the PR now
                  console.log(`[proxy] Pass ${pass}: Creating PR after review cycle...`);
                  await createPullRequest(issueId);
                  // Move issue to in_review so it stops triggering Local Builder
                  try {
                    await fetch(`${PAPERCLIP_API}/api/issues/${issueId}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ status: "in_review", assigneeAgentId: null }),
                    });
                    console.log(`[proxy] Issue moved to in_review (pipeline complete)`);
                  } catch {}
                  await postComment(issueId, null, `_Review cycle complete. PR created after incorporating Reviewer and Artist feedback._`);
                } else {
                  // First pass: send to Reviewer for code review (no PR)
                  console.log(`[proxy] Pass ${pass}: Sending to Reviewer (no PR yet)...`);
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

            // Strategist/Sentinel/Deployer/Reviewer/Artist: execute bash commands
            await executeBashBlocks(issueId, agentId, content);

            // Reviewer: auto-trigger Artist for visual audit after review
            if (agentId === AGENTS.reviewer) {
              try {
                await fetch(`${PAPERCLIP_API}/api/issues/${issueId}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ assigneeAgentId: AGENTS.artist }),
                });
                console.log(`[proxy] Auto-assigned to Artist for visual audit`);
              } catch (err) {
                console.error(`[proxy] Failed to trigger Artist:`, err.message);
              }
            }

            // Artist: capture screenshots, run vision analysis, then send back to Local Builder
            if (agentId === AGENTS.artist) {
              console.log(`[proxy] Artist triggered — capturing screenshots...`);
              const screenshots = await captureScreenshots(issueId);
              const validScreenshots = screenshots.filter(s => !s.error);
              if (validScreenshots.length > 0) {
                await analyzeScreenshots(issueId, screenshots);
                // Send back to Local Builder to fix feedback from both Reviewer and Artist
                try {
                  await postComment(issueId, AGENTS.artist,
                    `_Visual audit complete (${validScreenshots.length} screens analyzed). Assigning back to Local Builder to address Reviewer and Artist feedback._`
                  );
                  await fetch(`${PAPERCLIP_API}/api/issues/${issueId}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ assigneeAgentId: AGENTS["local builder"] }),
                  });
                  console.log(`[proxy] Auto-assigned back to Local Builder for fixes`);
                } catch (err) {
                  console.error(`[proxy] Failed to reassign to Local Builder:`, err.message);
                }
              } else {
                // No screenshots — skip visual audit, still assign to Local Builder
                // so pipeline doesn't stall, but flag the failure
                console.error(`[proxy] Artist: no screenshots captured, skipping vision analysis`);
                await postComment(issueId, AGENTS.artist,
                  `_Visual audit skipped: could not capture screenshots. Assigning to Local Builder with Reviewer feedback only._`
                );
                try {
                  await fetch(`${PAPERCLIP_API}/api/issues/${issueId}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ assigneeAgentId: AGENTS["local builder"] }),
                  });
                } catch {}
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

for (const [proxyPort, ollamaPort] of Object.entries(PROXY_MAP)) {
  createProxy(parseInt(proxyPort), ollamaPort);
}
console.log("[proxy] All proxies started.");
