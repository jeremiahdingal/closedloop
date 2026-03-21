/**
 * Git operations (branch, commit, push, PR creation)
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getWorkspace } from './config';
import { getIssueDetails, postComment } from './paperclip-api';
import { issueBuilderPasses } from './agent-types';
import { slugify, truncate, listPngFilesRecursive } from './utils';

const WORKSPACE = getWorkspace();
const GH_CLI = 'C:\\Program Files\\GitHub CLI\\gh';
const SCREENSHOT_BASE = path.join(__dirname, '..', '.screenshots');

export async function getBranchName(issueId: string): Promise<string> {
  let issue;
  try {
    issue = await getIssueDetails(issueId);
  } catch {}

  const identifier = issue?.identifier || issueId.slice(0, 8);
  const title = issue?.title || 'Code changes';
  return `${identifier}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`.replace(/-+$/, '');
}

export interface BuildResult {
  success: boolean;
  output?: string;
}

/**
 * Commit changed files to a branch, push, and run build validation.
 * Returns build result so caller can verify before handoff.
 */
export async function commitAndPush(
  issueId: string,
  files: string[],
  fileContents: Record<string, string>
): Promise<BuildResult> {
  const buildResult: BuildResult = { success: false };
  
  if (files.length === 0) return { success: true };

  const branchName = await getBranchName(issueId);
  let issue;
  try {
    issue = await getIssueDetails(issueId);
  } catch {}

  const identifier = issue?.identifier || issueId.slice(0, 8);
  const title = issue?.title || 'Code changes';
  const opts = { cwd: WORKSPACE, stdio: 'pipe' as const, timeout: 30000 };

  try {
    // Discard any uncommitted changes on master before switching
    try {
      execSync('git checkout -- .', opts);
    } catch {}

    // Create and switch to branch from master
    try {
      execSync(`git checkout -b ${branchName} master`, opts);
    } catch {
      // Branch might exist, just switch
      execSync(`git checkout ${branchName}`, opts);
    }

    // Write files directly onto the branch
    for (const f of files) {
      const fullPath = path.join(WORKSPACE, f);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, fileContents[f]);
    }

    // Stage the specifically files
    for (const f of files) {
      execSync(`git add "${f}"`, opts);
    }

    // Commit
    const pass = issueBuilderPasses[issueId] || 1;
    const commitMsg = `${identifier}: ${title} (pass ${pass})`;
    try {
      execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, opts);
      console.log(`[git] Committed: ${commitMsg}`);
    } catch (commitErr: any) {
      const commitStdout = commitErr.stdout?.toString() || '';
      const commitStderr = commitErr.stderr?.toString() || '';
      const commitStatus = commitErr.status ?? 1;

      console.error(`[git] Git commit FAILED (exit ${commitStatus}):`);
      console.error(`[git] Commit stdout: ${commitStdout}`);
      console.error(`[git] Commit stderr: ${commitStderr}`);
      console.error(`[git] Files staged: ${files.join(', ')}`);

      throw new Error(`Git commit failed: ${commitStderr || commitStdout || 'unknown error'}`);
    }

    // Push
    try {
      execSync(`git push -u origin ${branchName}`, { ...opts, timeout: 60000 });
      console.log(`[git] Pushed branch: ${branchName}`);
    } catch (err: any) {
      console.error(`[git] Push failed (no remote?):`, err.message);
      await postComment(
        issueId,
        null,
        `_Code committed to branch \`${branchName}\` (${files.length} files). Push failed: ${err.message}_`
      );
      execSync('git checkout master', opts);
      return buildResult;
    }

    await postComment(
      issueId,
      null,
      `_Code committed to branch \`${branchName}\` (pass ${pass})_\n\nFiles:\n${files.map((f) => '- `' + f + '`').join('\n')}`
    );

    // Run build validation on the branch
    console.log(`[git] Running build validation on branch ${branchName}...`);
    try {
      try {
        execSync('turbo prune --scope=@shop-diary/api 2>nul || yarn cache clean', {
          cwd: WORKSPACE,
          stdio: 'pipe',
        });
      } catch {}
      execSync('yarn build --force', { ...opts, timeout: 120000 });
      console.log(`[git] Build PASSED on ${branchName}`);
      await postComment(issueId, null, '_Build validation: PASSED_');
      buildResult.success = true;
    } catch (buildErr: any) {
      const buildStdout = buildErr.stdout?.toString() || '';
      const buildStderr = buildErr.stderr?.toString() || '';
      const buildOutput = truncate((buildStdout + '\n' + buildStderr).trim(), 3000);

      console.error(`[git] Build FAILED on ${branchName}`);
      buildResult.output = buildOutput;
      await postComment(
        issueId,
        null,
        `_Build validation: FAILED_\n\`\`\`\n${buildOutput}\n\`\`\``
      );
    }

    // Switch back to master
    execSync('git checkout master', opts);
  } catch (err: any) {
    console.error(`[git] Git workflow error:`, err.message);
    try {
      execSync('git checkout master', opts);
    } catch {}
    await postComment(issueId, null, `_Git workflow error: ${err.message}_`);
    buildResult.output = err.message;
  }
  
  return buildResult;
}

export async function createPullRequest(issueId: string): Promise<void> {
  const branchName = await getBranchName(issueId);
  let issue;
  try {
    issue = await getIssueDetails(issueId);
  } catch {}

  const identifier = issue?.identifier || issueId.slice(0, 8);
  const title = issue?.title || 'Code changes';
  const commitMsg = `${identifier}: ${title}`;
  const opts = { cwd: WORKSPACE, stdio: 'pipe' as const, timeout: 30000 };

  try {
    // Check if an OPEN PR already exists for this branch
    let existingPr = '';
    try {
      const prState = execSync(
        `"${GH_CLI}" pr view ${branchName} --json url,state --jq "select(.state==\\"OPEN\\") | .url"`,
        { ...opts, timeout: 30000 }
      )
        .toString()
        .trim();
      existingPr = prState;
    } catch {}

    if (existingPr) {
      console.log(`[git] PR already exists (open): ${existingPr}`);
      await postComment(issueId, null, `_PR already exists: ${existingPr}_`);
      return;
    }

    // Checkout the branch to add screenshots
    try {
      execSync(`git checkout ${branchName}`, opts);
    } catch {
      console.error(`[git] Could not checkout ${branchName} to add screenshots`);
    }

    // Collect screenshots from the per-issue dir
    const screenshotFiles: string[] = [];
    const screenshotDir = path.join(SCREENSHOT_BASE, issueId.slice(0, 8));
    const pngs = listPngFilesRecursive(screenshotDir);

    if (pngs.length > 0) {
      // Copy screenshots into a PR-visible directory on the branch
      const prScreenshotDir = path.join(
        WORKSPACE,
        'docs',
        'screenshots',
        identifier.toLowerCase()
      );
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
        console.log(`[git] Committed ${screenshotFiles.length} screenshots to ${branchName}`);
      } catch (err: any) {
        console.log(`[git] Screenshot commit/push note: ${err.message}`);
      }
    }

    // Switch back to master
    try {
      execSync('git checkout master', opts);
    } catch {}

    // Build PR body with screenshot images
    const GITHUB_REPO = 'jeremiahdingal/shop-diary-v3';
    let prBody = `Auto-generated from issue ${identifier}\n\n`;
    prBody += `## Changes\n(see commits on branch)\n\n`;

    // Generate diff summary for PR body
    try {
      const diffStat = execSync(`git diff --stat master..${branchName}`, {
        ...opts,
        timeout: 30000,
      })
        .toString()
        .trim();
      const diffShort = execSync(`git diff --name-only master..${branchName}`, {
        ...opts,
        timeout: 30000,
      })
        .toString()
        .trim();

      if (diffStat) {
        prBody += `## Files Changed\n\n\`\`\`\n${diffStat}\n\`\`\`\n\n`;
        prBody += `**Warning:** Review the changes carefully before merging. Check that package.json files retain all necessary dependencies.\n\n`;
      }
    } catch (e: any) {
      console.log(`[git] Could not generate diff summary: ${e.message}`);
    }

    if (screenshotFiles.length > 0) {
      prBody += `## Screenshots (Artist Feature Recording)\n\n`;
      for (const f of screenshotFiles) {
        const routeName = path.basename(f, '.png');
        const rawUrl = `https://github.com/${GITHUB_REPO}/blob/${branchName}/${f}?raw=true`;
        prBody += `### \`${routeName}\`\n![${routeName}](${rawUrl})\n\n`;
      }
    }

    // Create PR
    const prOutput = execSync(
      `"${GH_CLI}" pr create --head "${branchName}" --title "${commitMsg.replace(/"/g, '\\"')}" --body "${prBody.replace(/"/g, '\\"')}"`,
      { ...opts, timeout: 60000 }
    )
      .toString()
      .trim();

    console.log(`[git] PR created: ${prOutput}`);
    await postComment(
      issueId,
      null,
      `_PR created (with ${screenshotFiles.length} screenshots): ${prOutput}_`
    );
  } catch (err: any) {
    console.error(`[git] PR creation failed:`, err.message);
    await postComment(
      issueId,
      null,
      `_Branch \`${branchName}\` pushed. PR creation failed: ${err.message}_`
    );
    try {
      execSync('git checkout master', { cwd: WORKSPACE, stdio: 'pipe' });
    } catch {}
  }
}
