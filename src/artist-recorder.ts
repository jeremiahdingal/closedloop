/**
 * Artist Agent: deterministic Playwright feature recorder
 * This module is large - keeping it in one file for now since it's self-contained
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawn } from 'child_process';
import { getWorkspace, getArtistConfig } from './config';
import { getIssueDetails, getIssueComments, postComment, patchIssue } from './paperclip-api';
import { AGENTS } from './agent-types';
import { ensureDir, writeJson, appendNdjson, listPngFilesRecursive, normalizeRoute, safeJsonParse, slugify, truncate } from './utils';
import { ArtistFlow, ArtistStep, ArtistReport, ArtistStepResult } from './types';

const WORKSPACE = getWorkspace();
const ARTIST_CONFIG = getArtistConfig();
const DEV_SERVER_PORT = ARTIST_CONFIG.devServerPort;
const ARTIST_VIEWPORT = ARTIST_CONFIG.viewport;
const ARTIST_STEP_TIMEOUT_MS = ARTIST_CONFIG.stepTimeoutMs;
const SCREENSHOT_BASE = path.join(__dirname, '..', '.screenshots');

export function getArtifactDir(issueId: string): string {
  return path.join(SCREENSHOT_BASE, issueId.slice(0, 8));
}

function getIssueTexts(issue: any, comments: any[]): string[] {
  const texts: string[] = [];
  if (issue?.title) texts.push(issue.title);
  if (issue?.description) texts.push(issue.description);
  for (const c of comments || []) {
    if (c?.body) texts.push(c.body);
  }
  return texts;
}

function normalizeArtistStep(step: any): ArtistStep | null {
  if (!step || typeof step !== 'object') return null;
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

function parseArtistFlowFromText(text: string): ArtistFlow | null {
  const blockRegex = /```(?:json|artist-flow)?\n([\s\S]*?)```/gi;
  let match;
  while ((match = blockRegex.exec(text)) !== null) {
    const parsed = safeJsonParse(match[1].trim());
    if (!parsed) continue;
    const flow = parsed.artistFlow || parsed.flow || parsed;
    if (!flow || !Array.isArray(flow.steps)) continue;

    return {
      name: flow.name || 'custom-flow',
      startRoute: normalizeRoute(flow.startRoute || '/'),
      steps: flow.steps.map(normalizeArtistStep).filter(Boolean) as ArtistStep[],
      source: 'json',
    };
  }
  return null;
}

function buildFallbackArtistFlow(issue: any, comments: any[]): ArtistFlow {
  const text = `${issue?.title || ''}\n${issue?.description || ''}\n${(comments || []).map((c: any) => c.body || '').join('\n')}`.toLowerCase();

  if (/(item|product|inventory)/i.test(text)) {
    return {
      name: 'items-flow',
      startRoute: '/items',
      source: 'heuristic',
      steps: [
        { action: 'goto', label: 'Open items page', target: '/items' },
        {
          action: 'click',
          label: 'Open add item UI',
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
        { action: 'screenshot', label: 'Record items feature state', optional: true },
      ].map(normalizeArtistStep) as ArtistStep[],
    };
  }

  if (/(categor)/i.test(text)) {
    return {
      name: 'categories-flow',
      startRoute: '/categories',
      source: 'heuristic',
      steps: [
        { action: 'goto', label: 'Open categories page', target: '/categories' },
        {
          action: 'click',
          label: 'Open category UI',
          selectors: [
            'button:has-text("Add Category")',
            'button:has-text("Add")',
            'button:has-text("New Category")',
            'button:has-text("Edit")',
          ],
          optional: true,
        },
        { action: 'screenshot', label: 'Record categories feature state', optional: true },
      ].map(normalizeArtistStep) as ArtistStep[],
    };
  }

  if (/(user|staff|team)/i.test(text)) {
    return {
      name: 'users-flow',
      startRoute: '/users',
      source: 'heuristic',
      steps: [
        { action: 'goto', label: 'Open users page', target: '/users' },
        {
          action: 'click',
          label: 'Open user invite/add UI',
          selectors: [
            'button:has-text("Invite")',
            'button:has-text("Add User")',
            'button:has-text("Add")',
            'button:has-text("New")',
          ],
          optional: true,
        },
        { action: 'screenshot', label: 'Record users feature state', optional: true },
      ].map(normalizeArtistStep) as ArtistStep[],
    };
  }

  if (/(setting|config|preference)/i.test(text)) {
    return {
      name: 'settings-flow',
      startRoute: '/settings',
      source: 'heuristic',
      steps: [
        { action: 'goto', label: 'Open settings page', target: '/settings' },
        { action: 'screenshot', label: 'Record settings feature state', optional: true },
      ].map(normalizeArtistStep) as ArtistStep[],
    };
  }

  if (/(shop|branding|theme|myshop)/i.test(text)) {
    return {
      name: 'myshop-flow',
      startRoute: '/myshop',
      source: 'heuristic',
      steps: [
        { action: 'goto', label: 'Open my shop page', target: '/myshop' },
        { action: 'screenshot', label: 'Record my shop feature state', optional: true },
      ].map(normalizeArtistStep) as ArtistStep[],
    };
  }

  return {
    name: 'smoke-flow',
    startRoute: '/',
    source: 'fallback',
    steps: [
      { action: 'goto', label: 'Open dashboard', target: '/' },
      { action: 'goto', label: 'Open items page', target: '/items', optional: true },
      { action: 'goto', label: 'Open categories page', target: '/categories', optional: true },
      { action: 'goto', label: 'Open settings page', target: '/settings', optional: true },
      { action: 'screenshot', label: 'Record final UI state', optional: true },
    ].map(normalizeArtistStep) as ArtistStep[],
  };
}

function resolveArtistFlow(issue: any, comments: any[]): ArtistFlow {
  for (const text of getIssueTexts(issue, comments)) {
    const parsed = parseArtistFlowFromText(text);
    if (parsed) return parsed;
  }
  return buildFallbackArtistFlow(issue, comments);
}

async function startArtistDevServer(issueId: string): Promise<any> {
  const SCREENSHOT_DIR = getArtifactDir(issueId);
  ensureDir(SCREENSHOT_DIR);

  let devProcess: any = null;
  let serverReady = false;
  const serverLogs: string[] = [];

  try {
    await fetch(`http://localhost:${DEV_SERVER_PORT}`, { signal: AbortSignal.timeout(2000) });
    serverReady = true;
    console.log(`[artist] Dev server already running on :${DEV_SERVER_PORT}`);
    return { devProcess: null, serverLogs, startedByUs: false };
  } catch {}

  console.log(`[artist] Starting dev server for feature recording...`);
  const dashboardWebDir = path.join(WORKSPACE, 'apps', 'dashboard-web');
  const nextBin = path.join(WORKSPACE, 'node_modules', '.bin', 'next');
  devProcess = spawn(nextBin, ['dev', '-p', String(DEV_SERVER_PORT)], {
    cwd: dashboardWebDir,
    shell: true,
    stdio: 'pipe',
    env: { ...process.env },
  });

  const handleLog = (type: string, chunk: string) => {
    const s = chunk.toString();
    serverLogs.push(`[${type}] ${s}`);
    if (s.includes('Ready') || s.includes('ready') || s.includes('compiled') || s.includes('localhost')) {
      serverReady = true;
    }
  };

  devProcess.stdout.on('data', (d: Buffer) => handleLog('stdout', d.toString()));
  devProcess.stderr.on('data', (d: Buffer) => handleLog('stderr', d.toString()));

  const startTime = Date.now();
  while (!serverReady && Date.now() - startTime < 60000) {
    await sleep(2000);
    try {
      await fetch(`http://localhost:${DEV_SERVER_PORT}`, { signal: AbortSignal.timeout(2000) });
      serverReady = true;
    } catch {}
  }

  if (!serverReady) {
    try {
      devProcess.kill();
    } catch {}
    const errMsg = truncate(serverLogs.join('').slice(0, 1200) || 'No error output', 1200);
    console.error(`[artist] Dev server failed to start within 60s: ${errMsg}`);
    await postComment(
      issueId,
      AGENTS['visual reviewer'],
      `_Feature recording failed: dev server did not start within 60s._\n\`\`\`\n${errMsg}\n\`\`\``
    );
    return null;
  }

  console.log(`[artist] Dev server ready on :${DEV_SERVER_PORT}`);
  return { devProcess, serverLogs, startedByUs: true };
}

async function stopArtistDevServer(handle: any): Promise<void> {
  if (!handle?.startedByUs || !handle.devProcess) return;
  try {
    handle.devProcess.kill();
    console.log('[artist] Dev server stopped');
  } catch {}
}

async function injectArtistAuth(page: any): Promise<any> {
  const fakeUser = {
    id: 'artist-bot',
    first_name: 'Artist',
    last_name: 'Bot',
    email: 'artist@shop-diary.local',
    role: 'Admin',
    shopId: 'artist-shop',
    shopName: 'Artist Audit Shop',
    shopShortDesc: 'Feature recording',
    shopColorTheme: 'purple',
    shopAdminId: 'artist-bot',
    shopLogo: '',
    created_at: new Date().toISOString(),
  };
  const fakeToken = 'artist-feature-recorder-token';

  await page.waitForTimeout(3000);

  return page.evaluate(
    (authData: any) => {
      const win = window as any;
      const store = win.__USER_STORE__;
      if (!store || typeof store.getState !== 'function') {
        return { success: false, reason: 'window.__USER_STORE__ not found' };
      }
      const state = store.getState();
      if (typeof state.signInUser === 'function') {
        state.signInUser({ user: authData.user, token: authData.token });
        return { success: true };
      }
      if (typeof store.setState === 'function') {
        store.setState({ user: authData.user, token: authData.token });
        return { success: true, method: 'setState' };
      }
      return { success: false, reason: 'signInUser/setState missing' };
    },
    { user: fakeUser, token: fakeToken }
  );
}

async function getFirstMatchingLocator(page: any, selectors: string[], timeoutMs = 2500): Promise<any> {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      return { locator, selector };
    } catch {}
  }
  return null;
}

class FeatureRecorder {
  issueId: string;
  flowName: string;
  artifactDir: string;
  screenshotsDir: string;
  videoDir: string;
  logsDir: string;
  eventsFile: string;
  runFile: string;
  reportFile: string;
  traceFile: string;
  steps: ArtistStepResult[];
  console: any[];
  pageErrors: any[];
  requestFailures: any[];
  navEvents: any[];
  screenshotPaths: string[];
  lastSignature: string | null;

  constructor(issueId: string, flowName: string, artifactDir: string) {
    this.issueId = issueId;
    this.flowName = flowName;
    this.artifactDir = artifactDir;
    this.screenshotsDir = path.join(artifactDir, 'screenshots');
    this.videoDir = path.join(artifactDir, 'video');
    this.logsDir = path.join(artifactDir, 'logs');
    this.eventsFile = path.join(artifactDir, 'events.ndjson');
    this.runFile = path.join(artifactDir, 'run.json');
    this.reportFile = path.join(artifactDir, 'report.md');
    this.traceFile = path.join(artifactDir, 'trace.zip');
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

  attachPageListeners(page: any) {
    page.on('console', (msg: any) => {
      const item = {
        ts: new Date().toISOString(),
        type: msg.type(),
        text: msg.text(),
      };
      this.console.push(item);
      appendNdjson(path.join(this.logsDir, 'console.ndjson'), item);
    });

    page.on('pageerror', (err: any) => {
      const item = {
        ts: new Date().toISOString(),
        message: err.message,
      };
      this.pageErrors.push(item);
      appendNdjson(path.join(this.logsDir, 'pageerrors.ndjson'), item);
    });

    page.on('requestfailed', (req: any) => {
      const item = {
        ts: new Date().toISOString(),
        url: req.url(),
        method: req.method(),
        failure: req.failure()?.errorText || 'unknown',
      };
      this.requestFailures.push(item);
      appendNdjson(path.join(this.logsDir, 'requestfailures.ndjson'), item);
    });

    page.on('framenavigated', (frame: any) => {
      if (frame !== page.mainFrame()) return;
      const item = {
        ts: new Date().toISOString(),
        url: frame.url(),
      };
      this.navEvents.push(item);
      appendNdjson(path.join(this.logsDir, 'navigation.ndjson'), item);
    });
  }

  logStep(step: ArtistStepResult) {
    this.steps.push(step);
    appendNdjson(this.eventsFile, step);
  }

  async computeSignature(page: any): Promise<string> {
    const url = page.url();
    const title = await page.title().catch(() => '');
    const heading = await page.locator('h1').first().textContent().catch(() => '');
    const body = await page.locator('body').innerText().catch(() => '');
    return `${url}::${title}::${heading || ''}::${body.slice(0, 800)}`;
  }

  async captureIfChanged(page: any, label: string): Promise<string | null> {
    const signature = await this.computeSignature(page);
    if (signature === this.lastSignature) return null;
    this.lastSignature = signature;
    return this.forceCapture(page, label);
  }

  async forceCapture(page: any, label: string): Promise<string> {
    const index = String(this.screenshotPaths.length + 1).padStart(3, '0');
    const filename = `${index}-${slugify(label)}.png`;
    const fullPath = path.join(this.screenshotsDir, filename);
    await page.screenshot({ path: fullPath, fullPage: true });
    this.screenshotPaths.push(fullPath);
    return fullPath;
  }

  writeSummary(meta: any): any {
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

async function executeArtistStep(page: any, step: ArtistStep, recorder: FeatureRecorder, baseUrl: string): Promise<void> {
  const startedAt = new Date().toISOString();
  const beforeUrl = page.url();

  try {
    switch (step.action) {
      case 'goto': {
        const url = step.target?.startsWith('http')
          ? step.target
          : `${baseUrl}${normalizeRoute(step.target || '/')}`;
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: step.timeoutMs || ARTIST_STEP_TIMEOUT_MS,
        });
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1200);
        break;
      }

      case 'click': {
        const selectors = step.selectors || (step.target ? [step.target] : []);
        const found = await getFirstMatchingLocator(page, selectors, 3000);
        if (!found) {
          if (step.optional) {
            recorder.logStep({
              ts: new Date().toISOString(),
              label: step.label,
              action: step.action,
              status: 'skipped',
              reason: 'No matching click selector found',
              selectors,
            });
            return;
          }
          throw new Error(`No matching selector found for click: ${selectors.join(', ')}`);
        }
        await found.locator.click({ timeout: step.timeoutMs || ARTIST_STEP_TIMEOUT_MS });
        await page.waitForTimeout(1200);
        break;
      }

      case 'fill': {
        const selectors = step.selectors || (step.target ? [step.target] : []);
        const found = await getFirstMatchingLocator(page, selectors, 3000);
        if (!found) {
          if (step.optional) {
            recorder.logStep({
              ts: new Date().toISOString(),
              label: step.label,
              action: step.action,
              status: 'skipped',
              reason: 'No matching fill selector found',
              selectors,
            });
            return;
          }
          throw new Error(`No matching selector found for fill: ${selectors.join(', ')}`);
        }
        await found.locator.fill(String(step.value || ''), {
          timeout: step.timeoutMs || ARTIST_STEP_TIMEOUT_MS,
        });
        await page.waitForTimeout(500);
        break;
      }

      case 'press': {
        const selectors = step.selectors || (step.target ? [step.target] : []);
        const found = await getFirstMatchingLocator(page, selectors, 3000);
        if (!found) {
          if (step.optional) {
            recorder.logStep({
              ts: new Date().toISOString(),
              label: step.label,
              action: step.action,
              status: 'skipped',
              reason: 'No matching press selector found',
              selectors,
            });
            return;
          }
          throw new Error(`No matching selector found for press: ${selectors.join(', ')}`);
        }
        await found.locator.press(String(step.value || 'Enter'), {
          timeout: step.timeoutMs || ARTIST_STEP_TIMEOUT_MS,
        });
        await page.waitForTimeout(800);
        break;
      }

      case 'waitForText': {
        await page.getByText(String(step.value || ''), { exact: false }).waitFor({
          timeout: step.timeoutMs || ARTIST_STEP_TIMEOUT_MS,
        });
        break;
      }

      case 'waitForSelector': {
        const selectors = step.selectors || (step.target ? [step.target] : []);
        const found = await getFirstMatchingLocator(page, selectors, step.timeoutMs || ARTIST_STEP_TIMEOUT_MS);
        if (!found && !step.optional) {
          throw new Error(`No selector became visible: ${selectors.join(', ')}`);
        }
        break;
      }

      case 'wait': {
        await page.waitForTimeout(Number(step.value || step.timeoutMs || 1000));
        break;
      }

      case 'screenshot': {
        const shot = await recorder.forceCapture(page, step.label);
        recorder.logStep({
          ts: new Date().toISOString(),
          label: step.label,
          action: step.action,
          status: 'ok',
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
            status: 'skipped',
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
      target: step.target || undefined,
      selectors: step.selectors || undefined,
      value: step.value || undefined,
      startedAt,
      finishedAt: new Date().toISOString(),
      beforeUrl,
      afterUrl: page.url(),
      status: 'ok',
      screenshotPath: screenshotPath || undefined,
    });
  } catch (err: any) {
    const screenshotPath = await recorder.forceCapture(page, `error-${step.label}`);
    recorder.logStep({
      ts: new Date().toISOString(),
      label: step.label,
      action: step.action,
      target: step.target || undefined,
      selectors: step.selectors || undefined,
      value: step.value || undefined,
      startedAt,
      finishedAt: new Date().toISOString(),
      beforeUrl,
      afterUrl: page.url(),
      status: step.optional ? 'skipped' : 'failed',
      error: err.message,
      screenshotPath,
    });

    if (!step.optional) throw err;
  }
}

function buildArtistReport(runData: any): string {
  const failedSteps = runData.steps.filter((s: any) => s.status === 'failed');
  const skippedSteps = runData.steps.filter((s: any) => s.status === 'skipped');
  const okSteps = runData.steps.filter((s: any) => s.status === 'ok');
  const topConsole = runData.console.filter((c: any) => c.type === 'error' || c.type === 'warning').slice(0, 5);
  const topRequests = runData.requestFailures.slice(0, 5);

  const lines: string[] = [];
  lines.push('# Feature Execution Report');
  lines.push('');
  lines.push(`Result: ${runData.status.toUpperCase()}`);
  lines.push(`Flow: ${runData.flowName}`);
  lines.push(`Source: ${runData.flowSource}`);
  lines.push(`Branch: ${runData.branchName}`);
  lines.push(`Base URL: ${runData.baseUrl}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- Steps completed: ${okSteps.length}`);
  lines.push(`- Steps failed: ${failedSteps.length}`);
  lines.push(`- Steps skipped: ${skippedSteps.length}`);
  lines.push(`- Screenshots captured: ${runData.screenshots.length}`);
  lines.push(`- Console errors/warnings: ${topConsole.length}`);
  lines.push(`- Failed network requests: ${topRequests.length}`);
  lines.push('');

  lines.push('## Timeline');
  for (const step of runData.steps) {
    const icon = step.status === 'ok' ? 'PASS' : step.status === 'failed' ? 'FAIL' : 'SKIP';
    const extra = step.error ? ` -- ${step.error}` : '';
    lines.push(`- ${icon} ${step.label}${extra}`);
  }
  lines.push('');

  if (topConsole.length > 0) {
    lines.push('## Console Findings');
    for (const item of topConsole) {
      lines.push(`- [${item.type}] ${truncate(item.text, 200)}`);
    }
    lines.push('');
  }

  if (topRequests.length > 0) {
    lines.push('## Failed Requests');
    for (const item of topRequests) {
      lines.push(`- ${item.method} ${item.url} -- ${item.failure}`);
    }
    lines.push('');
  }

  if (runData.screenshots.length > 0) {
    lines.push('## Screenshot Files');
    for (const filePath of runData.screenshots) {
      lines.push(`- ${filePath}`);
    }
    lines.push('');
  }

  lines.push('## Local Artifacts');
  lines.push(`- Video dir: ${runData.videoDir}`);
  lines.push(`- Trace: ${runData.tracePath}`);
  lines.push(`- Run JSON: ${runData.runFile}`);
  lines.push(`- Event log: ${runData.eventsFile}`);
  lines.push('');

  if (failedSteps.length > 0) {
    lines.push('## Highest Priority Findings');
    failedSteps.slice(0, 3).forEach((step: any, idx: number) => {
      lines.push(`${idx + 1}. ${step.label} failed`);
      if (step.error) lines.push(`   - Error: ${step.error}`);
      if (step.screenshotPath) lines.push(`   - Screenshot: ${step.screenshotPath}`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

export async function runArtistRecorder(issueId: string): Promise<any> {
  const artifactDir = getArtifactDir(issueId);
  ensureDir(artifactDir);

  const [issue, comments] = await Promise.all([getIssueDetails(issueId), getIssueComments(issueId)]);
  if (!issue) throw new Error('Issue not found');

  const flow = resolveArtistFlow(issue, comments);
  const branchName = await getBranchName(issueId);
  const baseUrl = `http://localhost:${DEV_SERVER_PORT}`;
  const opts = { cwd: WORKSPACE, stdio: 'pipe' as const, timeout: 30000 };

  await postComment(
    issueId,
    AGENTS['visual reviewer'],
    `_Starting feature recording on branch \`${branchName}\` using flow \`${flow.name}\` (${flow.source})._`
  );

  try {
    execSync(`git checkout ${branchName}`, opts);
    console.log(`[artist] checked out ${branchName} for feature recording`);
  } catch (err: any) {
    throw new Error(`Could not checkout feature branch ${branchName}: ${err.message}`);
  }

  const serverHandle = await startArtistDevServer(issueId);
  if (!serverHandle) {
    try {
      execSync('git checkout master', opts);
    } catch {}
    return null;
  }

  const recorder = new FeatureRecorder(issueId, flow.name, artifactDir);
  let browser: any = null;
  let context: any = null;
  let page: any = null;
  let videoHandle: any = null;

  try {
    const { chromium } = await import(path.join(WORKSPACE, 'node_modules', 'playwright'));
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
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    const authInjected = await injectArtistAuth(page);
    if (authInjected?.success) {
      console.log(`[artist] Auth injection succeeded`);
      await page.waitForTimeout(1000);
    } else {
      console.error(`[artist] Auth injection FAILED: ${authInjected?.reason}`);
      recorder.logStep({
        ts: new Date().toISOString(),
        label: 'Inject authenticated session',
        action: 'auth',
        status: 'failed',
        error: authInjected?.reason || 'auth injection failed',
      });
    }

    await recorder.forceCapture(page, 'initial-state');

    let failed = false;
    for (const step of flow.steps) {
      try {
        await executeArtistStep(page, step, recorder, baseUrl);
      } catch (err: any) {
        failed = true;
        console.error(`[artist] Step failed: ${step.label}: ${err.message}`);
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
      status: failed ? 'failed' : 'passed',
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

    try {
      execSync('git checkout master', opts);
    } catch {}

    return { ...runData, report };
  } catch (err: any) {
    console.error(`[artist] Recorder error:`, err.message);

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
      status: 'failed',
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
      serverLogs: serverHandle?.serverLogs,
    });

    const report = buildArtistReport(runData) + `\n\n## Fatal Error\n- ${err.message}\n`;
    fs.writeFileSync(recorder.reportFile, report);

    try {
      execSync('git checkout master', opts);
    } catch {}

    return { ...runData, report };
  }
}

async function getBranchName(issueId: string): Promise<string> {
  let issue;
  try {
    issue = await getIssueDetails(issueId);
  } catch {}
  const identifier = issue?.identifier || issueId.slice(0, 8);
  const title = issue?.title || 'Code changes';
  return `${identifier}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`.replace(/-+$/, '');
}

export async function runArtistStage(issueId: string): Promise<void> {
  // Import lock from agent-types
  const { artistProcessingLock } = await import('./agent-types');

  if (artistProcessingLock[issueId]) {
    console.log(`[artist] Skipping duplicate run for ${issueId.slice(0, 8)} (already processing)`);
    return;
  }

  artistProcessingLock[issueId] = true;
  try {
    const result = await runArtistRecorder(issueId);
    if (!result) return;

    await postComment(issueId, AGENTS['visual reviewer'], result.report);

    if (result.status === 'passed') {
      await postComment(
        issueId,
        AGENTS['visual reviewer'],
        `_Feature recording complete. Flow \`${result.flowName}\` passed visually. Moving issue to in_review._`
      );
      await patchIssue(issueId, { status: 'in_review', assigneeAgentId: undefined });
      console.log(`[artist] Issue ${issueId.slice(0, 8)} moved to in_review (pipeline complete)`);
    } else {
      await postComment(
        issueId,
        AGENTS['visual reviewer'],
        `_Feature recording complete with failures. Assigning back to Local Builder._`
      );
      await patchIssue(issueId, { assigneeAgentId: AGENTS['local builder'] });
      console.log(`[artist] Auto-assigned back to Local Builder after recording`);
    }
  } catch (err: any) {
    console.error(`[artist] Stage failed:`, err.message);
    await postComment(issueId, AGENTS['visual reviewer'], `_Feature recorder failed: ${err.message}_`);
    await patchIssue(issueId, { assigneeAgentId: AGENTS['local builder'] });
  } finally {
    artistProcessingLock[issueId] = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
