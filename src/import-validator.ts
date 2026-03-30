/**
 * Pre-flight Import Validation
 * 
 * Validates imports before build to catch hallucinated packages early.
 * Checks that all imported packages exist in package.json.
 * 
 * This prevents the most common build error (25% of failures):
 * "Module not found: Can't resolve 'ky'" — package doesn't exist
 */

import * as fs from 'fs';
import * as path from 'path';
import { getWorkspace, getStylingPolicy } from './config';

const WORKSPACE = getWorkspace();

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface ValidationResult {
  valid: boolean;
  errors: Array<{
    file: string;
    line: number;
    importPath: string;
    error: string;
  }>;
  warnings: Array<{
    file: string;
    line: number;
    importPath: string;
    warning: string;
  }>;
}

/**
 * Load and parse package.json files from the monorepo
 */
function loadPackageJsonPaths(): string[] {
  const packageJsonPaths: string[] = [];
  
  // Root package.json
  const rootPkg = path.join(WORKSPACE, 'package.json');
  if (fs.existsSync(rootPkg)) {
    packageJsonPaths.push(rootPkg);
  }
  
  // packages/* package.json files
  const packagesDir = path.join(WORKSPACE, 'packages');
  if (fs.existsSync(packagesDir)) {
    const packages = fs.readdirSync(packagesDir);
    for (const pkg of packages) {
      const pkgJson = path.join(packagesDir, pkg, 'package.json');
      if (fs.existsSync(pkgJson)) {
        packageJsonPaths.push(pkgJson);
      }
    }
  }
  
  // apps/* package.json files
  const appsDir = path.join(WORKSPACE, 'apps');
  if (fs.existsSync(appsDir)) {
    const apps = fs.readdirSync(appsDir);
    for (const app of apps) {
      const pkgJson = path.join(appsDir, app, 'package.json');
      if (fs.existsSync(pkgJson)) {
        packageJsonPaths.push(pkgJson);
      }
    }
  }
  
  return packageJsonPaths;
}

/**
 * Get all installed package names from package.json files
 */
function getInstalledPackages(): Set<string> {
  const packages = new Set<string>();
  const stylingPolicy = getStylingPolicy();
  const pkgPaths = loadPackageJsonPaths();
  
  for (const pkgPath of pkgPaths) {
    try {
      const content = fs.readFileSync(pkgPath, 'utf8');
      const pkg: PackageJson = JSON.parse(content);
      
      // Add all dependencies
      if (pkg.dependencies) {
        Object.keys(pkg.dependencies).forEach(name => packages.add(name));
      }
      if (pkg.devDependencies) {
        Object.keys(pkg.devDependencies).forEach(name => packages.add(name));
      }
      if (pkg.peerDependencies) {
        Object.keys(pkg.peerDependencies).forEach(name => packages.add(name));
      }
    } catch (err: any) {
      console.log(`[import-validator] Could not parse ${pkgPath}: ${err.message}`);
    }
  }
  
  // Add Node.js built-in modules (should not be flagged)
  const nodeBuiltins = [
    'fs', 'path', 'http', 'https', 'os', 'util', 'events', 'stream',
    'crypto', 'child_process', 'url', 'querystring', 'buffer', 'net',
  ];
  nodeBuiltins.forEach(name => packages.add(name));

  // Add common React/ecosystem packages that are often peer deps or transitive
  // These are typically provided by the framework/meta-package and shouldn't be flagged
  const commonEcosystem = [
    'react', 'react-native', 'react-dom',
    '@tanstack/react-query', '@tanstack/react-table',
    'expo', 'expo-router', 'expo-constants', 'expo-linking', 'expo-image-picker', 'expo-linear-gradient',
    'solito', 'next', 'next/router',
    '@babel/runtime',
  ];
  commonEcosystem.forEach(name => packages.add(name));
  stylingPolicy.required.forEach((name) => {
    if (name.includes('*')) return;
    packages.add(name);
  });

  return packages;
}

/**
 * Extract imports from TypeScript/JavaScript content
 */
function extractImports(content: string, filePath: string): Array<{ line: number; importPath: string }> {
  const imports: Array<{ line: number; importPath: string }> = [];
  const lines = content.split('\n');
  
  // Match: import X from 'package' or import 'package'
  const importRegex = /^\s*import\s+(?:type\s+)?(?:[\w{}\s,*]+from\s+)?['"]([^'"]+)['"]/;
  
  // Match: require('package')
  const requireRegex = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match = line.match(importRegex);
    
    if (!match) {
      match = line.match(requireRegex);
    }
    
    if (match) {
      const importPath = match[1];
      
      // Skip relative imports (they're local files)
      if (importPath.startsWith('.') || importPath.startsWith('/')) {
        continue;
      }
      
      // Skip type-only imports (they don't affect build)
      if (line.includes('import type')) {
        continue;
      }
      
      imports.push({
        line: i + 1,
        importPath,
      });
    }
  }
  
  return imports;
}

/**
 * Validate imports in a file against installed packages
 */
function validateFileImports(
  filePath: string,
  installedPackages: Set<string>
): Array<{ line: number; importPath: string; error: string }> {
  const errors: Array<{ line: number; importPath: string; error: string }> = [];
  
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const imports = extractImports(content, filePath);
    
    for (const { line, importPath } of imports) {
      // Extract package name (first part before /)
      const packageName = importPath.split('/')[0];
      
      // Check if package is installed
      if (!installedPackages.has(packageName)) {
        errors.push({
          line,
          importPath,
          error: `Package '${packageName}' is not installed`,
        });
      }
    }
  } catch (err: any) {
    // File read error - skip
  }
  
  return errors;
}

/**
 * Validate all imports in generated code
 * 
 * Call this after Builder writes files but before build.
 * Catches hallucinated packages early.
 */
export function validateImports(files: Array<{ path: string; content: string }>): ValidationResult {
  const installedPackages = getInstalledPackages();
  const stylingPolicy = getStylingPolicy();
  const errors: ValidationResult['errors'] = [];
  const warnings: ValidationResult['warnings'] = [];
  
  for (const file of files) {
    const fullPath = path.join(WORKSPACE, file.path);
    
    // Validate imports
    const fileErrors = validateFileImports(fullPath, installedPackages);
    
    for (const err of fileErrors) {
      errors.push({
        file: file.path,
        line: err.line,
        importPath: err.importPath,
        error: err.error,
      });
    }
    
    // Check for common hallucinated packages (add warnings even if installed)
    const hallucinationPatterns = [
      { pattern: /ky/i, suggestion: 'Use fetcherWithToken from app/utils/fetcherWithToken instead' },
      { pattern: /axios/i, suggestion: 'Use native fetch or fetcherWithToken instead' },
      { pattern: /lodash/i, suggestion: 'Use native array methods or @radix-ui utilities instead' },
      {
        pattern: /styled-components|emotion|@emotion/i,
        suggestion: `Use ${stylingPolicy.framework} conventions instead${stylingPolicy.guidance ? ` (${stylingPolicy.guidance})` : ''}`,
      },
    ];

    const forbiddenStyling = stylingPolicy.forbidden.map((v) => v.toLowerCase());
    if (forbiddenStyling.some((v) => v.includes('stylesheet.create'))) {
      hallucinationPatterns.push({
        pattern: /StyleSheet\.create/i,
        suggestion: `Avoid StyleSheet.create in this project. ${stylingPolicy.guidance}`,
      });
    }
    if (forbiddenStyling.some((v) => v.includes('tailwind'))) {
      hallucinationPatterns.push({
        pattern: /tailwind|className\s*=|tw`/i,
        suggestion: `Avoid Tailwind patterns in this project. Use ${stylingPolicy.framework} instead.`,
      });
    }
    
    const content = file.content;
    for (const { pattern, suggestion } of hallucinationPatterns) {
      if (pattern.test(content)) {
        const match = content.match(pattern);
        if (match) {
          warnings.push({
            file: file.path,
            line: content.substring(0, match.index).split('\n').length,
            importPath: match[0],
            warning: suggestion,
          });
        }
      }
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Format validation result as human-readable message
 */
export function formatValidationResult(result: ValidationResult): string {
  if (result.valid && result.warnings.length === 0) {
    return '✅ All imports validated successfully';
  }
  
  let message = '';
  
  if (result.errors.length > 0) {
    message += '❌ **Import Validation Failed**\n\n';
    message += `Found ${result.errors.length} error${result.errors.length === 1 ? '' : 's'}:\n\n`;
    
    for (const err of result.errors) {
      message += `- **${err.file}:${err.line}**: ${err.error}\n`;
      message += `  Import: \`${err.importPath}\`\n`;
    }
    
    message += '\n**Fix:** Add the package to package.json or use an existing alternative.\n\n';
  }
  
  if (result.warnings.length > 0) {
    message += '⚠️ **Warnings**\n\n';
    
    for (const warn of result.warnings) {
      message += `- **${warn.file}:${warn.line}**: ${warn.warning}\n`;
      message += `  Import: \`${warn.importPath}\`\n`;
    }
  }
  
  return message;
}
