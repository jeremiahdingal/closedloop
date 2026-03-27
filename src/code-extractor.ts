/**
 * Code block extraction and validation
 */

import * as fs from 'fs';
import * as path from 'path';
import { getWorkspace } from './config';
import { FileValidation, CodeExtractionResult } from './types';

const WORKSPACE = getWorkspace();

/**
 * Validate file content before writing. Returns { valid: boolean, reason?: string }.
 */
export function validateFileContent(filePath: string, code: string): FileValidation {
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
            reason: `package.json would delete ${origDepCount - newDepCount} dependencies (${origDepCount} → ${newDepCount}). Did you mean to modify instead of replace?`,
          };
        }
      }

      // New package.json should have at least scripts OR dependencies
      if (!hasScripts && hasDepsCount === 0) {
        return { valid: false, reason: 'package.json has no scripts or dependencies' };
      }
    } catch (e: any) {
      return { valid: false, reason: `Invalid JSON: ${e.message}` };
    }
  }

  return { valid: true };
}

/**
 * Check if a new file appears to duplicate existing functionality.
 * Returns { valid: boolean, reason?: string }.
 */
export function validateNewFileDuplication(filePath: string, code: string): FileValidation {
  const basename = path.basename(filePath, path.extname(filePath));
  const dirname = path.dirname(filePath);

  // Check for store files that might duplicate existing stores
  if (filePath.includes('/store/') && filePath.endsWith('.ts')) {
    const existingStores = ['useUserStore', 'useShopStore', 'useCartStore', 'useAuthStore'];

    for (const existingStore of existingStores) {
      const existingPath = path.join(dirname, `${existingStore}.ts`);
      if (fs.existsSync(path.join(WORKSPACE, existingPath))) {
        // Check if the new file has similar exports/functionality
        if (code.includes('create<') && code.includes('persist')) {
          return {
            valid: false,
            reason: `New store file may duplicate existing ${existingStore}.ts. Modify the existing file instead of creating a new store.`,
          };
        }
      }
    }
  }

  // Check for type files that might duplicate existing types
  if (filePath.includes('/types/') && filePath.endsWith('.ts')) {
    const existingTypeFiles = ['auth.schema.ts', 'shop.schema.ts', 'items.schema.ts'];

    for (const existingFile of existingTypeFiles) {
      const existingPath = path.join(WORKSPACE, 'packages/app/types/schemas', existingFile);
      if (fs.existsSync(existingPath)) {
        // Check if new file exports types that might overlap
        const newExports = code.match(/export\s+(?:interface|type)\s+(\w+)/g) || [];
        if (newExports.length > 2) {
          return {
            valid: false,
            reason: `New type file may duplicate types in ${existingFile}. Add types to the existing schema file instead.`,
          };
        }
      }
    }
  }

  return { valid: true };
}

/**
 * Validate that changes to critical files don't break existing functionality.
 * Returns { valid: boolean, reason?: string, preservedMethods?: string[] }.
 */
export function validateCriticalFileChanges(
  filePath: string,
  oldContent: string,
  newContent: string
): FileValidation {
  // For store files (zustand), check that essential methods are preserved
  if (filePath.includes('/store/') || filePath.includes('store.')) {
    const oldMethods = oldContent.match(/(\w+):\s*\([^)]*\)\s*=>/g) || [];
    const oldMethodNames = oldMethods.map((m) => m.split(':')[0].trim());

    const newMethods = newContent.match(/(\w+):\s*\([^)]*\)\s*=>/g) || [];
    const newMethodNames = newMethods.map((m) => m.split(':')[0].trim());

    const removedMethods = oldMethodNames.filter((m) => !newMethodNames.includes(m));

    if (removedMethods.length > 0) {
      return {
        valid: false,
        reason: `Store file is removing required methods: ${removedMethods.join(', ')}. These methods may be used by other parts of the app.`,
      };
    }
  }

  // For type files, check that essential interfaces are preserved
  if (filePath.includes('/types/') || filePath.includes('types.')) {
    const oldInterfaces = oldContent.match(/export\s+(?:interface|type)\s+(\w+)/g) || [];
    const oldInterfaceNames = oldInterfaces.map((i) => i.split(/\s+/)[2]);

    const newInterfaces = newContent.match(/export\s+(?:interface|type)\s+(\w+)/g) || [];
    const newInterfaceNames = newInterfaces.map((i) => i.split(/\s+/)[2]);

    const removedInterfaces = oldInterfaceNames.filter((i) => !newInterfaceNames.includes(i));

    if (removedInterfaces.length > 0) {
      return {
        valid: false,
        reason: `Type file is removing exported types: ${removedInterfaces.join(', ')}. These types may be imported by other files.`,
      };
    }
  }

  // For auth files, check that essential functions are preserved
  if (filePath.includes('/auth/') || filePath.includes('auth.')) {
    const essentialPatterns = [/export.*useRegister/, /export.*useLogin/, /export.*register/, /export.*login/];

    for (const pattern of essentialPatterns) {
      if (pattern.test(oldContent) && !pattern.test(newContent)) {
        return {
          valid: false,
          reason: `Auth file is removing essential exports. Check that all authentication functions are preserved.`,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Extract code blocks with file paths from LLM output and write them to disk.
 * Returns array of written file paths (relative to workspace).
 */
export function applyCodeBlocks(content: string, workspace?: string): CodeExtractionResult {
  const ws = workspace || WORKSPACE;
  const written: string[] = [];
  const fileContents: Record<string, string> = {};

  console.log(
    `[extract] applyCodeBlocks: content length=${content.length}, has FILE:=${content.includes('FILE:')}, backticks=${(content.match(/```/g) || []).length}`
  );

  // Pattern 1: FILE: path before code block
  const fileBeforeBlock = /\*{0,2}FILE:\s*([\w./\\-]+\.\w+)\s*\*{0,2}\s*\n```[^\n]*\n([\s\S]*?)```/g;
  // Pattern 2: // path inside code block
  const fileInsideBlock = /```[^\n]*\n(?:\/\/|--|#)\s*([\w./\\-]+\.\w+)\s*\n([\s\S]*?)```/g;

  for (const blockRegex of [fileBeforeBlock, fileInsideBlock]) {
    let match;
    while ((match = blockRegex.exec(content)) !== null) {
      let filePath = match[1].trim().replace(/`/g, '');
      const code = match[2];

      console.log(`[extract] matched file="${filePath}", code length=${code.length}`);

      // Skip if already written by a previous pattern
      if (written.includes(filePath)) {
        console.log(`[extract] skipping "${filePath}" (already written)`);
        continue;
      }

      // Safety: reject absolute paths and traversal
      if (path.isAbsolute(filePath) || filePath.includes('..')) {
        console.log(`[extract] Rejected unsafe path: ${filePath}`);
        continue;
      }

      const fullPath = path.join(ws, filePath);
      if (!path.resolve(fullPath).startsWith(path.resolve(ws))) {
        console.log(`[extract] Path escapes workspace: ${filePath}`);
        continue;
      }

      // Validate file content
      const validation = validateFileContent(filePath, code);
      if (!validation.valid) {
        console.log(`[extract] Rejected ${filePath}: ${validation.reason}`);
        continue;
      }

      // For critical files, check for destructive changes
      if (fs.existsSync(fullPath)) {
        const oldContent = fs.readFileSync(fullPath, 'utf8');
        const criticalValidation = validateCriticalFileChanges(filePath, oldContent, code);
        if (!criticalValidation.valid) {
          console.log(`[extract] BLOCKED destructive change to ${filePath}: ${criticalValidation.reason}`);
          continue;
        }
      } else {
        // For NEW files, check if they might be duplicating existing functionality
        const duplicationCheck = validateNewFileDuplication(filePath, code);
        if (!duplicationCheck.valid) {
          console.log(`[extract] BLOCKED new file ${filePath}: ${duplicationCheck.reason}`);
          continue;
        }
      }

      written.push(filePath);
      fileContents[filePath] = code;
      console.log(`[extract] Extracted file: ${filePath}`);
    }
  }

  console.log(`[extract] total files extracted=${written.length}`);
  return { written, fileContents };
}
