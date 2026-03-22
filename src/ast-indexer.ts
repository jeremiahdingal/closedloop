/**
 * AST-Based RAG Indexing
 *
 * Extracts structural information from TypeScript files using regex-based
 * parsing (no ts-morph dependency — keeps it lightweight for consumer PCs).
 *
 * Captures:
 *   - Function signatures with parameter types and return types
 *   - Interface/type definitions with field shapes
 *   - Class definitions with method signatures
 *   - Enum values
 *   - Import/export relationships
 *
 * This gives the RAG index structural queries like:
 *   "find all functions that accept orderId" → matches function signatures
 *   "find the Zod schema for payments" → matches interface/type shapes
 */

// ─── Types ───────────────────────────────────────────────────────

export interface FunctionSignature {
  name: string;
  params: string;
  returnType: string;
  exported: boolean;
  async: boolean;
}

export interface InterfaceShape {
  name: string;
  fields: Array<{ name: string; type: string; optional: boolean }>;
  exported: boolean;
}

export interface EnumShape {
  name: string;
  values: string[];
  exported: boolean;
}

export interface ImportDeclaration {
  names: string[];
  source: string;
}

export interface ASTMetadata {
  functions: FunctionSignature[];
  interfaces: InterfaceShape[];
  enums: EnumShape[];
  imports: ImportDeclaration[];
  /** Compact string representation for RAG search text */
  searchText: string;
}

// ─── Extraction ──────────────────────────────────────────────────

/**
 * Extract function signatures from TypeScript content.
 */
export function extractFunctions(content: string): FunctionSignature[] {
  const functions: FunctionSignature[] = [];

  // Match: [export] [async] function name(params): returnType
  const funcRegex = /^[ \t]*(export\s+)?(?:declare\s+)?(async\s+)?function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^\n{]+))?/gm;
  let match;
  while ((match = funcRegex.exec(content)) !== null) {
    functions.push({
      name: match[3],
      params: match[4].trim(),
      returnType: (match[5] || 'void').trim(),
      exported: !!match[1],
      async: !!match[2],
    });
  }

  // Match: [export] const name = [async] (params): returnType =>
  // Return type can include generics like Promise<Response> so we match up to =>
  const arrowRegex = /(?:^|[\n;])\s*(export\s+)?(?:const|let)\s+(\w+)\s*=\s*(async\s+)?\(([^)]*)\)(?:\s*:\s*(.+?))?\s*=>/g;
  while ((match = arrowRegex.exec(content)) !== null) {
    functions.push({
      name: match[2],
      params: match[4].trim(),
      returnType: (match[5] || 'void').trim(),
      exported: !!match[1],
      async: !!match[3],
    });
  }

  return functions;
}

/**
 * Extract interface and type definitions from TypeScript content.
 */
export function extractInterfaces(content: string): InterfaceShape[] {
  const interfaces: InterfaceShape[] = [];

  // Match: [export] interface Name { ... }
  const interfaceRegex = /(export\s+)?interface\s+(\w+)(?:\s+extends\s+[^{]+)?\s*\{([^}]*)\}/gs;
  let match;
  while ((match = interfaceRegex.exec(content)) !== null) {
    const name = match[2];
    const body = match[3];
    const fields = parseFields(body);
    interfaces.push({ name, fields, exported: !!match[1] });
  }

  // Match: [export] type Name = { ... }
  const typeObjRegex = /(export\s+)?type\s+(\w+)\s*=\s*\{([^}]*)\}/gs;
  while ((match = typeObjRegex.exec(content)) !== null) {
    const name = match[2];
    const body = match[3];
    const fields = parseFields(body);
    if (fields.length > 0) {
      interfaces.push({ name, fields, exported: !!match[1] });
    }
  }

  return interfaces;
}

function parseFields(body: string): Array<{ name: string; type: string; optional: boolean }> {
  const fields: Array<{ name: string; type: string; optional: boolean }> = [];
  const fieldRegex = /(\w+)(\?)?:\s*([^;\n]+)/g;
  let m;
  while ((m = fieldRegex.exec(body)) !== null) {
    // Skip method signatures (they contain parentheses)
    if (m[3].includes('(')) continue;
    fields.push({
      name: m[1],
      type: m[3].trim().replace(/,$/, ''),
      optional: !!m[2],
    });
  }
  return fields;
}

/**
 * Extract enum definitions from TypeScript content.
 */
export function extractEnums(content: string): EnumShape[] {
  const enums: EnumShape[] = [];
  const enumRegex = /(export\s+)?enum\s+(\w+)\s*\{([^}]*)\}/gs;
  let match;
  while ((match = enumRegex.exec(content)) !== null) {
    const name = match[2];
    const body = match[3];
    const values = body
      .split(',')
      .map(v => v.trim().split(/\s*=/)[0].trim())
      .filter(v => v.length > 0 && /^\w+$/.test(v));
    enums.push({ name, values, exported: !!match[1] });
  }
  return enums;
}

/**
 * Extract import declarations from TypeScript content.
 */
export function extractImports(content: string): ImportDeclaration[] {
  const imports: ImportDeclaration[] = [];
  const importRegex = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const names = match[1].split(',').map(n => n.trim()).filter(Boolean);
    imports.push({ names, source: match[2] });
  }

  // Default imports
  const defaultRegex = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = defaultRegex.exec(content)) !== null) {
    imports.push({ names: [match[1]], source: match[2] });
  }

  return imports;
}

// ─── Full extraction ─────────────────────────────────────────────

/**
 * Extract all AST metadata from a TypeScript file's content.
 */
export function extractASTMetadata(content: string): ASTMetadata {
  const functions = extractFunctions(content);
  const interfaces = extractInterfaces(content);
  const enums = extractEnums(content);
  const imports = extractImports(content);

  // Build compact search text for RAG keyword matching
  const parts: string[] = [];

  for (const fn of functions) {
    parts.push(`fn:${fn.name}(${fn.params})${fn.returnType !== 'void' ? ':' + fn.returnType : ''}`);
  }
  for (const iface of interfaces) {
    const fieldNames = iface.fields.map(f => f.name).join(',');
    parts.push(`interface:${iface.name}{${fieldNames}}`);
  }
  for (const en of enums) {
    parts.push(`enum:${en.name}[${en.values.join(',')}]`);
  }

  return {
    functions,
    interfaces,
    enums,
    imports,
    searchText: parts.join(' '),
  };
}

/**
 * Format AST metadata as a compact summary for RAG documents.
 * This replaces or augments the flat "exports" list with structural info.
 */
export function formatASTSummary(meta: ASTMetadata): string {
  const lines: string[] = [];

  if (meta.functions.length > 0) {
    lines.push('Functions:');
    for (const fn of meta.functions) {
      const prefix = fn.exported ? 'export ' : '';
      const asyncPrefix = fn.async ? 'async ' : '';
      lines.push(`  ${prefix}${asyncPrefix}${fn.name}(${fn.params}): ${fn.returnType}`);
    }
  }

  if (meta.interfaces.length > 0) {
    lines.push('Types:');
    for (const iface of meta.interfaces) {
      const prefix = iface.exported ? 'export ' : '';
      const fields = iface.fields.map(f => `${f.name}${f.optional ? '?' : ''}: ${f.type}`).join(', ');
      lines.push(`  ${prefix}${iface.name} { ${fields} }`);
    }
  }

  if (meta.enums.length > 0) {
    lines.push('Enums:');
    for (const en of meta.enums) {
      lines.push(`  ${en.exported ? 'export ' : ''}${en.name}: ${en.values.join(', ')}`);
    }
  }

  return lines.join('\n');
}
