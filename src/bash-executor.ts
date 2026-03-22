/**
 * Bash command execution for agents
 */

import { execSync } from 'child_process';
import { getWorkspace } from './config';
import { BASH_AGENTS, BLOCKED_COMMANDS } from './agent-types';
import { postComment } from './paperclip-api';
import { truncate } from './utils';

const WORKSPACE = getWorkspace();

/**
 * Execute bash code blocks from agent output and post results as comments.
 * Returns true if any commands were executed.
 */
export async function executeBashBlocks(
  issueId: string,
  agentId: string,
  content: string
): Promise<boolean> {
  if (!BASH_AGENTS.has(agentId)) return false;

  const bashRegex = /```(?:bash|shell|sh)\n([\s\S]*?)```/g;
  let match;
  let commandsExecuted = 0;

  while ((match = bashRegex.exec(content)) !== null) {
    let command = match[1].trim();
    if (!command) continue;

    // Strip comment lines (# ...) for Windows compatibility
    command = command
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
      .trim();
    if (!command) continue;

    // Convert Unix commands to Windows equivalents
    command = convertCommandForWindows(command);

    // Safety check
    if (BLOCKED_COMMANDS.some((rx) => rx.test(command))) {
      console.log(`[bash] BLOCKED dangerous command: ${command}`);
      await postComment(issueId, null, `_Blocked dangerous command: \`${command}\`_`);
      continue;
    }

    console.log(`[bash] Executing for ${agentId.slice(0, 8)}: ${command.slice(0, 80)}`);

    try {
      const output = execSync(command, {
        cwd: WORKSPACE,
        stdio: 'pipe',
        timeout: 30000,
      }).toString();

      const truncOutput = truncate(output, 2000);
      await postComment(
        issueId,
        null,
        `_Command: \`${command}\`_\n_Exit code: 0_\n\`\`\`\n${truncOutput}\n\`\`\``
      );
      commandsExecuted++;
    } catch (err: any) {
      const stderr = err.stderr?.toString() || err.message;
      const stdout = err.stdout?.toString() || '';
      const exitCode = err.status ?? 1;
      const truncOutput = truncate((stdout + '\n' + stderr).trim(), 2000);

      await postComment(
        issueId,
        null,
        `_Command: \`${command}\`_\n_Exit code: ${exitCode}_\n\`\`\`\n${truncOutput}\n\`\`\``
      );
      commandsExecuted++;
    }
  }

  return commandsExecuted > 0;
}

function convertCommandForWindows(command: string): string {
  return command
    .replace(/\bls\s+-la\b/g, 'dir')
    .replace(/\bls\s+-l\b/g, 'dir')
    .replace(/\bls\s+-a\b/g, 'dir /a')
    .replace(/\bls\b/g, 'dir')
    .replace(/\bdir\s+-la\b/g, 'dir')
    .replace(/\bdir\s+-l\b/g, 'dir')
    .replace(/\bdir\s+-a\b/g, 'dir /a')
    .replace(/\bcat\b/g, 'type')
    .replace(/\bgrep\b/g, 'findstr')
    .replace(/\bfind\b/g, 'dir /s /b')
    .replace(/\brm\b/g, 'del')
    .replace(/\bmv\b/g, 'move')
    .replace(/\bcp\b/g, 'copy')
    .replace(/\bchmod\b/g, 'attrib')
    .replace(/\bhead\s+-\d+\b/g, 'more')
    .replace(/\btail\s+-\d+\b/g, 'more')
    .replace(/\bhead\b/g, 'more')
    .replace(/\btail\b/g, 'more')
    .replace(/\|/g, '|')
    .replace(/\b\/dev\/null\b/g, 'nul')
    .replace(/\bmore\s+-\d+\b/g, 'more')
    .replace(/([a-zA-Z]\w*\/)+[a-zA-Z]\w*(?:\.\w+)?\/?/g, (match) =>
      match.replace(/\//g, '\\')
    );
}
