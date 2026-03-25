/**
 * Scaffold Executor — Applies scaffold output to the workspace.
 *
 * Reads current shared files, patches them with scaffold additions,
 * and writes all new files. No LLM involved.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ScaffoldConfig,
  ScaffoldTemplate,
  SHOP_DIARY_TEMPLATE,
  generateScaffold,
  patchServicesEnum,
  patchDbTypes,
  patchIndexTs,
  apiConfigToFrontendConfig,
  generateFrontendScaffold,
} from './scaffold-engine';

export interface ScaffoldResult {
  success: boolean;
  filesWritten: string[];
  filesPatched: string[];
  errors: string[];
}

/**
 * Execute a scaffold config against a workspace.
 * Creates new files and patches shared files (index.ts, db.types.ts, services.enum.ts).
 */
export function executeScaffold(config: ScaffoldConfig, workspace: string, template: ScaffoldTemplate = SHOP_DIARY_TEMPLATE): ScaffoldResult {
  const result: ScaffoldResult = {
    success: true,
    filesWritten: [],
    filesPatched: [],
    errors: [],
  };

  const scaffold = generateScaffold(config, template);

  // 1. Write new files (skip if already exists to avoid overwriting working code)
  for (const file of scaffold.files) {
    const fullPath = path.join(workspace, file.path);
    try {
      if (fs.existsSync(fullPath)) {
        result.filesWritten.push(`${file.path} (skipped - already exists)`);
        continue;
      }
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(fullPath, file.content, 'utf8');
      result.filesWritten.push(file.path);
    } catch (err: any) {
      result.errors.push(`Failed to write ${file.path}: ${err.message}`);
      result.success = false;
    }
  }

  // 2. Patch shared files (paths come from template)
  try {
    // services.enum.ts
    const enumPath = path.join(workspace, template.paths.servicesEnum);
    if (fs.existsSync(enumPath)) {
      const current = fs.readFileSync(enumPath, 'utf8');
      const patched = patchServicesEnum(current, config.table);
      if (patched !== current) {
        fs.writeFileSync(enumPath, patched, 'utf8');
        result.filesPatched.push(template.paths.servicesEnum);
      }
    }
  } catch (err: any) {
    result.errors.push(`Failed to patch ${template.paths.servicesEnum}: ${err.message}`);
    result.success = false;
  }

  try {
    // db.types.ts
    const dbTypesPath = path.join(workspace, template.paths.dbTypes);
    if (fs.existsSync(dbTypesPath)) {
      const current = fs.readFileSync(dbTypesPath, 'utf8');
      const patched = patchDbTypes(current, config.entityPascal, config.table, config.entity + '.schema');
      if (patched !== current) {
        fs.writeFileSync(dbTypesPath, patched, 'utf8');
        result.filesPatched.push(template.paths.dbTypes);
      }
    }
  } catch (err: any) {
    result.errors.push(`Failed to patch ${template.paths.dbTypes}: ${err.message}`);
    result.success = false;
  }

  try {
    // entrypoint (index.ts)
    const indexPath = path.join(workspace, template.paths.entrypoint);
    if (fs.existsSync(indexPath)) {
      const current = fs.readFileSync(indexPath, 'utf8');
      const patched = patchIndexTs(current, config.entityCamel, config.entity, template.patterns.registrationInsertBefore);
      if (patched !== current) {
        fs.writeFileSync(indexPath, patched, 'utf8');
        result.filesPatched.push(template.paths.entrypoint);
      }
    }
  } catch (err: any) {
    result.errors.push(`Failed to patch ${template.paths.entrypoint}: ${err.message}`);
    result.success = false;
  }

  // 3. Write frontend scaffold files (Tamagui screens, dialogs, hooks)
  const frontendConfig = apiConfigToFrontendConfig(config);
  const frontendScaffold = generateFrontendScaffold(frontendConfig);
  for (const file of frontendScaffold.files) {
    const fullPath = path.join(workspace, file.path);
    try {
      if (fs.existsSync(fullPath)) {
        result.filesWritten.push(`${file.path} (skipped - already exists)`);
        continue;
      }
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(fullPath, file.content, 'utf8');
      result.filesWritten.push(file.path);
    } catch (err: any) {
      result.errors.push(`Failed to write ${file.path}: ${err.message}`);
      result.success = false;
    }
  }

  return result;
}

/**
 * Format scaffold result as a human-readable comment for Paperclip.
 */
export function formatScaffoldComment(config: ScaffoldConfig, result: ScaffoldResult): string {
  if (!result.success) {
    return `**Scaffold Failed**\n\nErrors:\n${result.errors.map((e) => `- ${e}`).join('\n')}`;
  }

  const newFiles = result.filesWritten.map((f) => `- \`${f}\``).join('\n');
  const patchedFiles = result.filesPatched.map((f) => `- \`${f}\``).join('\n');

  return `**Scaffold Complete: ${config.entityPascal} Full-Stack Feature**

**New files created:**
${newFiles}

**Shared files patched:**
${patchedFiles}

**Entity:** ${config.entityPascal}
**Table:** ${config.table}
**ID Field:** ${config.idField}
**Fields:** ${config.fields.map((f) => f.name).join(', ')}
**Routes:** ${config.routes.map((r) => `${r.method.toUpperCase()} ${r.path}`).join(', ')}

_Deterministic scaffold — zero LLM tokens used._`;
}
