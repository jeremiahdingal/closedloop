/**
 * Scaffold Engine — Deterministic code generation for CRUD API services.
 *
 * Takes a structured ScaffoldConfig + ScaffoldTemplate and generates exact files
 * matching the target project's patterns. Template is swappable per-project.
 *
 * Zero LLM usage. Free, instant, deterministic.
 */

// ────────────────────── Types ──────────────────────

export interface ScaffoldField {
  name: string;            // e.g. "amount"
  type: 'text' | 'integer' | 'real' | 'blob';  // D1/SQLite column types
  zodType: string;         // e.g. "z.number()", "z.string()"
  tsType: string;          // e.g. "number", "string"
  notNull?: boolean;       // default true
  primaryKey?: boolean;    // default false (the ID field is auto-added)
}

export interface ScaffoldRoute {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;            // e.g. "/payments", "/payments/:id"
  handler: string;         // e.g. "getAll", "create", "getById", "update", "delete"
  needsBody?: boolean;     // true for POST/PUT/PATCH
  paramName?: string;      // e.g. "id" for :id routes
}

export interface ScaffoldConfig {
  entity: string;          // e.g. "payment-types" (kebab-case, used for dir/file names)
  entityCamel: string;     // e.g. "paymentTypes" (used for variable names)
  entityPascal: string;    // e.g. "PaymentTypes" (used for types/enums)
  entitySingular: string;  // e.g. "paymentType" (for single-item references)
  table: string;           // e.g. "PaymentTypes" (DatabaseTables enum key = IDatabase key)
  idField: string;         // e.g. "paymentTypeId" or just "id"
  fields: ScaffoldField[]; // non-ID columns
  routes: ScaffoldRoute[]; // CRUD routes
  middleware?: {
    auth?: boolean;        // wrap with withAuthenticatedUser
    mutation?: boolean;    // wrap with sendMutationSignal
  };
}

/**
 * Project-specific file layout and import conventions.
 * Swap this to target a different monorepo structure.
 */
export interface ScaffoldTemplate {
  // ── File paths (relative to workspace root) ──
  paths: {
    schema: (entity: string) => string;          // e.g. "packages/app/types/schemas/payment-types.schema.ts"
    service: (entity: string) => string;         // e.g. "api/src/services/payment-types/payment-types.service.ts"
    routes: (entity: string) => string;          // e.g. "api/src/services/payment-types/payment-types.routes.ts"
    migration: (entity: string) => string;       // e.g. "api/src/services/payment-types/payment-types.migration.ts"
    servicesEnum: string;                        // e.g. "packages/app/types/services.enum.ts"
    dbTypes: string;                             // e.g. "packages/app/types/db.types.ts"
    entrypoint: string;                          // e.g. "api/src/index.ts"
  };

  // ── Import paths used inside generated code ──
  imports: {
    env: string;                   // e.g. "app/types/env.types"
    servicesEnum: string;          // e.g. "app/types/services.enum"
    dbTypes: string;               // e.g. "app/types/db.types"
    schemaModule: (entity: string) => string;  // e.g. "app/types/schemas/payment-types.schema"
    db: string;                    // e.g. "../../infra/db"
    applyRoutes: string;           // e.g. "../../utils/applyRoutes"
    errorHandler: string;          // e.g. "../../utils/errorHandler"
    authMiddleware?: string;       // e.g. "../../middlewares/withAuthenticatedUser"
    mutationMiddleware?: string;   // e.g. "../../middlewares/sendMutationSignal"
  };

  // ── Library imports ──
  libs: {
    router: string;        // e.g. "itty-router"
    orm: string;           // e.g. "kysely"
    validation: string;    // e.g. "zod"
    id: string;            // e.g. "ulidx"
  };

  // ── Code patterns ──
  patterns: {
    /** How to import the db factory. e.g. "import { db } from '../../infra/db'" */
    dbImport: string;
    /** How to call the db factory. e.g. "db(env)" */
    dbCall: string;
    /** Service export style: 'named' (export { xService }) or 'default' (export default) */
    serviceExport: 'named' | 'default';
    /** Router export style: 'named' or 'default' */
    routerExport: 'named' | 'default';
    /** Route registration pattern in entrypoint: '{routerName}(router)' or 'router.use(...)' */
    routeRegistration: (routerName: string) => string;
    /** Marker before which to insert route registration (e.g. "route404(router)") */
    registrationInsertBefore?: string;
  };
}

export interface ScaffoldOutput {
  files: Array<{ path: string; content: string }>;
  appendFiles: Array<{ path: string; marker: string; content: string }>;
}

// ────────────────────── Default template: shop-diary-v3 ──────────────────────

export const SHOP_DIARY_TEMPLATE: ScaffoldTemplate = {
  paths: {
    schema: (e) => `packages/app/types/schemas/${e}.schema.ts`,
    service: (e) => `api/src/services/${e}/${e}.service.ts`,
    routes: (e) => `api/src/services/${e}/${e}.routes.ts`,
    migration: (e) => `api/src/services/${e}/${e}.migration.ts`,
    servicesEnum: 'packages/app/types/services.enum.ts',
    dbTypes: 'packages/app/types/db.types.ts',
    entrypoint: 'api/src/index.ts',
  },
  imports: {
    env: 'app/types/env.types',
    servicesEnum: 'app/types/services.enum',
    dbTypes: 'app/types/db.types',
    schemaModule: (e) => `app/types/schemas/${e}.schema`,
    db: '../../infra/db',
    applyRoutes: '../../utils/applyRoutes',
    errorHandler: '../../utils/errorHandler',
    authMiddleware: '../../middlewares/withAuthenticatedUser',
    mutationMiddleware: '../../middlewares/sendMutationSignal',
  },
  libs: {
    router: 'itty-router',
    orm: 'kysely',
    validation: 'zod',
    id: 'ulidx',
  },
  patterns: {
    dbImport: `import { db } from '../../infra/db';`,
    dbCall: 'db(env)',
    serviceExport: 'named',
    routerExport: 'named',
    routeRegistration: (name) => `${name}(router);`,
    registrationInsertBefore: 'route404(router)',
  },
};

// ────────────────────── Default CRUD config helper ──────────────────────

/**
 * Build a standard CRUD route set from entity info.
 */
export function defaultCrudRoutes(entity: string, idField: string): ScaffoldRoute[] {
  return [
    { method: 'get', path: `/${entity}`, handler: 'getAll' },
    { method: 'get', path: `/${entity}/:id`, handler: 'getById', paramName: 'id' },
    { method: 'post', path: `/${entity}/create`, handler: 'create', needsBody: true },
    { method: 'put', path: `/${entity}/:id`, handler: 'update', paramName: 'id', needsBody: true },
    { method: 'delete', path: `/${entity}/:id`, handler: 'delete', paramName: 'id' },
  ];
}

// ────────────────────── Generator ──────────────────────

export function generateScaffold(config: ScaffoldConfig, template: ScaffoldTemplate = SHOP_DIARY_TEMPLATE): ScaffoldOutput {
  const files: ScaffoldOutput['files'] = [];
  const appendFiles: ScaffoldOutput['appendFiles'] = [];

  // 1. Schema file
  files.push({
    path: template.paths.schema(config.entity),
    content: generateSchema(config, template),
  });

  // 2. Service file
  files.push({
    path: template.paths.service(config.entity),
    content: generateService(config, template),
  });

  // 3. Routes file
  files.push({
    path: template.paths.routes(config.entity),
    content: generateRoutes(config, template),
  });

  // 4. Migration file
  files.push({
    path: template.paths.migration(config.entity),
    content: generateMigration(config, template),
  });

  // 5. Append to services.enum.ts
  appendFiles.push({
    path: template.paths.servicesEnum,
    marker: 'DatabaseTables',
    content: `\t${config.table} = '${config.table}',`,
  });

  // 6. Append to db.types.ts (import + interface entry + type exports)
  appendFiles.push({
    path: template.paths.dbTypes,
    marker: 'IDatabase',
    content: [
      `// --- ${config.entityPascal} ---`,
      `import { T${config.entityPascal}Table } from './schemas/${config.entity}.schema'`,
      `// Add to IDatabase: ${config.table}: T${config.entityPascal}Table`,
      `export type T${config.entityPascal} = Selectable<T${config.entityPascal}Table>`,
      `export type TNew${config.entityPascal} = Insertable<T${config.entityPascal}Table>`,
      `export type T${config.entityPascal}Update = Updateable<T${config.entityPascal}Table>`,
    ].join('\n'),
  });

  // 7. Entrypoint registration
  const routerName = `${config.entityCamel}Router`;
  appendFiles.push({
    path: template.paths.entrypoint,
    marker: 'router',
    content: [
      `import { ${routerName} } from './services/${config.entity}/${config.entity}.routes';`,
      template.patterns.routeRegistration(routerName),
    ].join('\n'),
  });

  return { files, appendFiles };
}

// ────────────────────── File generators ──────────────────────

function generateSchema(config: ScaffoldConfig, template: ScaffoldTemplate): string {
  const allFields = [
    { name: config.idField, zodType: 'z.string()', tsType: 'string', primaryKey: true },
    ...config.fields,
  ];

  const zodFields = allFields
    .map((f) => `  ${f.name}: ${f.zodType},`)
    .join('\n');

  const tableTypeFields = config.fields
    .map((f) => `  ${f.name}: ${f.tsType}`)
    .join('\n');

  return `import { Generated } from '${template.libs.orm}'
import { z } from '${template.libs.validation}'

export const ${config.entityCamel}Schema = z.object({
${zodFields}
})

export const create${config.entityPascal}Schema = ${config.entityCamel}Schema.omit({ ${config.idField}: true })
export const update${config.entityPascal}Schema = ${config.entityCamel}Schema.partial()

export type T${config.entityPascal}Table = Omit<z.TypeOf<typeof ${config.entityCamel}Schema>, '${config.idField}'> & {
  ${config.idField}: Generated<string>
}
`;
}

function generateService(config: ScaffoldConfig, template: ScaffoldTemplate): string {
  const handlers: string[] = [];
  const importTypes: string[] = [];

  for (const route of config.routes) {
    switch (route.handler) {
      case 'getAll':
        handlers.push(`\tasync function getAll() {
\t\tconst items = await ${template.patterns.dbCall}.selectFrom(DatabaseTables.${config.table}).selectAll().execute();
\t\treturn json(items);
\t}`);
        break;

      case 'getById':
        handlers.push(`\tasync function getById(${config.idField}: string) {
\t\tconst item = await ${template.patterns.dbCall}
\t\t\t.selectFrom(DatabaseTables.${config.table})
\t\t\t.where('${config.idField}', '=', ${config.idField})
\t\t\t.selectAll()
\t\t\t.executeTakeFirstOrThrow();
\t\treturn json(item);
\t}`);
        break;

      case 'create':
        importTypes.push(`TNew${config.entityPascal}`);
        handlers.push(`\tasync function create(data: TNew${config.entityPascal}) {
\t\tconst details = { ...data, ${config.idField}: ulid() };
\t\tawait ${template.patterns.dbCall}.insertInto(DatabaseTables.${config.table}).values(details).execute();
\t\treturn json('OK');
\t}`);
        break;

      case 'update':
        importTypes.push(`T${config.entityPascal}Update`);
        handlers.push(`\tasync function update(${config.idField}: string, data: T${config.entityPascal}Update) {
\t\tconst updated = await ${template.patterns.dbCall}
\t\t\t.updateTable(DatabaseTables.${config.table})
\t\t\t.set(data)
\t\t\t.where('${config.idField}', '=', ${config.idField})
\t\t\t.returningAll()
\t\t\t.execute();
\t\treturn json(updated);
\t}`);
        break;

      case 'delete':
        handlers.push(`\tasync function remove(${config.idField}: string) {
\t\tawait ${template.patterns.dbCall}.deleteFrom(DatabaseTables.${config.table}).where('${config.idField}', '=', ${config.idField}).execute();
\t\treturn json(\`Deleted \${${config.idField}}\`);
\t}`);
        break;
    }
  }

  const uniqueTypes = [...new Set(importTypes)];
  const typeImport = uniqueTypes.length > 0
    ? `import { ${uniqueTypes.join(', ')} } from '${template.imports.dbTypes}';\n`
    : '';

  const exportedNames = config.routes.map((r) => {
    if (r.handler === 'delete') return 'remove';
    return r.handler;
  });

  return `import { error, json } from '${template.libs.router}';
import { ulid } from '${template.libs.id}';
import { DatabaseTables } from '${template.imports.servicesEnum}';
import { Env } from '${template.imports.env}';
${template.patterns.dbImport}
${typeImport}
const ${config.entityCamel}Service = (env: Env) => {
${handlers.join('\n\n')}

\treturn {
${exportedNames.map((n) => `\t\t${n},`).join('\n')}
\t};
};

export { ${config.entityCamel}Service };
`;
}

function generateRoutes(config: ScaffoldConfig, template: ScaffoldTemplate): string {
  const routeFunctions: string[] = [];
  const routeNames: string[] = [];

  // Migration route
  const migrationName = `${config.entityCamel}Migrate`;
  routeNames.push(migrationName);

  const columnDefs = config.fields
    .map((f) => {
      const mods = f.notNull !== false ? `col => col.notNull()` : `col => col`;
      return `\t\t\t.addColumn('${f.name}', '${f.type}', ${mods})`;
    })
    .join('\n');

  routeFunctions.push(`const ${migrationName} = (router: RouterType) =>
\trouter.get('/${config.entity}/migrate', async (req, env: Env) => {
\t\tconst res = await ${template.patterns.dbCall}
\t\t\t.schema.createTable(DatabaseTables.${config.table})
\t\t\t.addColumn('${config.idField}', 'text', col => col.primaryKey().notNull())
${columnDefs}
\t\t\t.execute();
\t\treturn Response.json(res);
\t});`);

  // Generic middleware route (auth + mutation signal)
  if (config.middleware?.auth || config.middleware?.mutation) {
    const genericName = `${config.entityCamel}Generic`;
    routeNames.push(genericName);

    const middlewares: string[] = [];
    if (config.middleware.auth) middlewares.push('withAuthenticatedUser');
    if (config.middleware.mutation) middlewares.push(`sendMutationSignal(DatabaseTables.${config.table})`);

    routeFunctions.push(`const ${genericName} = (router: RouterType) =>
\trouter.all('/${config.entity}/*', ${middlewares.join(', ')});`);
  }

  // CRUD routes
  for (const route of config.routes) {
    const fnName = `${config.entityCamel}${capitalize(route.handler)}`;
    routeNames.push(fnName);

    let body: string;

    switch (route.handler) {
      case 'getAll':
        body = `return ${config.entityCamel}Service(env).getAll();`;
        break;
      case 'getById':
        body = `const ${config.idField} = req.params.${route.paramName || 'id'};\n\t\t\treturn ${config.entityCamel}Service(env).getById(${config.idField});`;
        break;
      case 'create':
        body = `const data = create${config.entityPascal}Schema.parse(await req.json());\n\t\t\treturn ${config.entityCamel}Service(env).create(data);`;
        break;
      case 'update':
        body = `const ${config.idField} = req.params.${route.paramName || 'id'};\n\t\t\tconst data = update${config.entityPascal}Schema.parse(await req.json());\n\t\t\treturn ${config.entityCamel}Service(env).update(${config.idField}, data);`;
        break;
      case 'delete':
        body = `const ${config.idField} = req.params.${route.paramName || 'id'};\n\t\t\treturn ${config.entityCamel}Service(env).remove(${config.idField});`;
        break;
      default:
        body = `// TODO: implement ${route.handler}`;
    }

    routeFunctions.push(`const ${fnName} = (router: RouterType) =>
\trouter.${route.method}('${route.path}', async (req, env: Env) => {
\t\ttry {
\t\t\t${body}
\t\t} catch (e) {
\t\t\treturn errorHandler(e);
\t\t}
\t});`);
  }

  // Build imports
  const imports: string[] = [
    `import { Env } from '${template.imports.env}';`,
    `import { DatabaseTables } from '${template.imports.servicesEnum}';`,
    `import { IRequest, Route, RouterType, error } from '${template.libs.router}';`,
    template.patterns.dbImport,
    `import { applyRoutes } from '${template.imports.applyRoutes}';`,
    `import { errorHandler } from '${template.imports.errorHandler}';`,
    `import { ${config.entityCamel}Service } from './${config.entity}.service';`,
  ];

  // Schema imports for create/update validation
  const hasCreate = config.routes.some((r) => r.handler === 'create');
  const hasUpdate = config.routes.some((r) => r.handler === 'update');
  const schemaImports: string[] = [];
  if (hasCreate) schemaImports.push(`create${config.entityPascal}Schema`);
  if (hasUpdate) schemaImports.push(`update${config.entityPascal}Schema`);
  if (schemaImports.length > 0) {
    imports.push(`import { ${schemaImports.join(', ')} } from '${template.imports.schemaModule(config.entity)}';`);
  }

  // Middleware imports
  if (config.middleware?.auth && template.imports.authMiddleware) {
    imports.push(`import { withAuthenticatedUser } from '${template.imports.authMiddleware}';`);
  }
  if (config.middleware?.mutation && template.imports.mutationMiddleware) {
    imports.push(`import { sendMutationSignal } from '${template.imports.mutationMiddleware}';`);
  }

  return `${imports.join('\n')}

${routeFunctions.join('\n\n')}

const routes = [${routeNames.join(', ')}];

export const ${config.entityCamel}Router = (router: RouterType) => applyRoutes(routes, router);
`;
}

function generateMigration(config: ScaffoldConfig, template: ScaffoldTemplate): string {
  const columnDefs = config.fields
    .map((f) => {
      const mods: string[] = [];
      if (f.notNull !== false) mods.push('notNull()');
      const modStr = mods.length > 0 ? `col => col.${mods.join('.')}` : `col => col`;
      return `\t\t\t.addColumn('${f.name}', '${f.type}', ${modStr})`;
    })
    .join('\n');

  return `import { Env } from '${template.imports.env}';
import { DatabaseTables } from '${template.imports.servicesEnum}';
${template.patterns.dbImport}

export async function migrate${config.entityPascal}(env: Env) {
\tawait ${template.patterns.dbCall}
\t\t.schema.createTable(DatabaseTables.${config.table})
\t\t.addColumn('${config.idField}', 'text', col => col.primaryKey().notNull())
${columnDefs}
\t\t.execute();
}
`;
}

// ────────────────────── Shared file modification ──────────────────────

/**
 * Generate the full content of services.enum.ts with new table entry added.
 */
export function patchServicesEnum(currentContent: string, table: string): string {
  // Find the closing brace of DatabaseTables enum
  const enumMatch = currentContent.match(/(export enum DatabaseTables \{[\s\S]*?)(^\})/m);
  if (!enumMatch) {
    // Fallback: just append
    return currentContent + `\n// Added by scaffold\nexport enum DatabaseTables { ${table} = '${table}' }\n`;
  }

  // Check if already present
  if (currentContent.includes(`${table} =`)) {
    return currentContent;
  }

  // Insert before closing brace
  const insertPoint = currentContent.lastIndexOf('}');
  const beforeBrace = currentContent.substring(0, insertPoint);
  const lastLine = beforeBrace.trimEnd();
  const needsComma = !lastLine.endsWith(',') && !lastLine.endsWith('{');

  return (
    lastLine +
    (needsComma ? ',' : '') +
    `\n\t${table} = '${table}',\n` +
    currentContent.substring(insertPoint)
  );
}

/**
 * Generate the full content of db.types.ts with new table types added.
 */
export function patchDbTypes(
  currentContent: string,
  entityPascal: string,
  table: string,
  schemaFile: string
): string {
  let result = currentContent;

  // 1. Add import (before IDatabase interface)
  const importLine = `import { T${entityPascal}Table } from './schemas/${schemaFile}'`;
  if (!result.includes(importLine)) {
    // Insert after last import
    const lastImportIdx = result.lastIndexOf("import ");
    const lineEnd = result.indexOf('\n', lastImportIdx);
    result = result.substring(0, lineEnd + 1) + importLine + '\n' + result.substring(lineEnd + 1);
  }

  // 2. Add to IDatabase interface
  const interfaceEntry = `  ${table}: T${entityPascal}Table`;
  if (!result.includes(interfaceEntry)) {
    const interfaceClose = result.indexOf('}', result.indexOf('export interface IDatabase'));
    result = result.substring(0, interfaceClose) + interfaceEntry + '\n' + result.substring(interfaceClose);
  }

  // 3. Add type exports
  const typeExports = [
    `export type T${entityPascal} = Selectable<T${entityPascal}Table>`,
    `export type TNew${entityPascal} = Insertable<T${entityPascal}Table>`,
    `export type T${entityPascal}Update = Updateable<T${entityPascal}Table>`,
  ];

  for (const exp of typeExports) {
    if (!result.includes(exp)) {
      result = result.trimEnd() + '\n\n' + exp;
    }
  }

  // Only add trailing newline if not already present
  if (!result.endsWith('\n')) {
    result += '\n';
  }
  return result;
}

/**
 * Generate the full content of index.ts with new router registration added.
 */
export function patchIndexTs(
  currentContent: string,
  entityCamel: string,
  entity: string,
  insertBefore?: string   // e.g. "route404(router)" — where to insert registration
): string {
  let result = currentContent;

  // 1. Add import
  const routerName = `${entityCamel}Router`;
  const importLine = `import { ${routerName} } from './services/${entity}/${entity}.routes';`;
  if (!result.includes(importLine)) {
    // Insert after last import line
    const lastImportIdx = result.lastIndexOf("import ");
    const lineEnd = result.indexOf('\n', lastImportIdx);
    result = result.substring(0, lineEnd + 1) + importLine + '\n' + result.substring(lineEnd + 1);
  }

  // 2. Add router registration
  const registration = `${routerName}(router);`;
  if (!result.includes(registration)) {
    const marker = insertBefore || 'route404(router)';
    const markerIdx = result.indexOf(marker);
    if (markerIdx > -1) {
      result = result.substring(0, markerIdx) + registration + '\n' + result.substring(markerIdx);
    } else {
      // Fallback: insert before export default
      const exportIdx = result.indexOf('export default');
      if (exportIdx > -1) {
        result = result.substring(0, exportIdx) + registration + '\n\n' + result.substring(exportIdx);
      }
    }
  }

  return result;
}

// ────────────────────── Template detection ──────────────────────

/**
 * Detect if an issue description matches a scaffold-able CRUD pattern.
 * Returns a ScaffoldConfig if match is strong, null otherwise.
 */
export function detectScaffoldConfig(title: string, description: string): ScaffoldConfig | null {
  const text = (title + '\n' + description).toLowerCase();

  // Must have clear entity + CRUD signals
  const crudSignals = ['crud', 'api', 'service', 'endpoint', 'routes', 'create', 'read', 'update', 'delete'];
  const crudScore = crudSignals.filter((s) => text.includes(s)).length;

  if (crudScore < 2) return null;

  // Try to extract entity info from structured ticket format
  // Look for patterns like: entity: payment-types, table: PaymentTypes
  // Use original text (not lowercased) for field names to preserve casing
  const originalText = title + '\n' + description;
  const entityMatch = text.match(/entity[:\s]+([a-z][a-z0-9-]+)/i);
  const tableMatch = originalText.match(/table[:\s]+([A-Z][a-zA-Z]+)/);
  const fieldsMatch = originalText.match(/fields?[:\s]*\n([\s\S]*?)(?:\n\n|\n##|\nroutes)/i);

  if (!entityMatch) return null;

  const entity = entityMatch[1].toLowerCase();
  const entityCamel = kebabToCamel(entity);
  const entityPascal = kebabToPascal(entity);
  const entitySingular = entityCamel.replace(/s$/, ''); // naive singularization
  const table = tableMatch ? tableMatch[1] : entityPascal;
  const idField = entitySingular + 'Id';

  // Parse fields if present
  const fields: ScaffoldField[] = [];
  if (fieldsMatch) {
    const fieldLines = fieldsMatch[1].split('\n').filter((l) => l.trim());
    for (const line of fieldLines) {
      const fMatch = line.match(/[-*]\s*([\w]+)\s*[:\-]\s*(text|integer|real|string|number|boolean)/i);
      if (fMatch) {
        const name = fMatch[1]; // preserve original casing (e.g. isActive, shopId)
        const rawType = fMatch[2].toLowerCase();
        const type = rawType === 'string' ? 'text' : rawType === 'number' ? 'integer' : rawType === 'boolean' ? 'integer' : rawType as any;
        const zodType = rawType === 'number' || rawType === 'integer' || rawType === 'real' ? 'z.number()' : 'z.string()';
        const tsType = rawType === 'number' || rawType === 'integer' || rawType === 'real' ? 'number' : 'string';
        fields.push({ name, type, zodType, tsType, notNull: true });
      }
    }
  }

  if (fields.length === 0) return null; // Need at least some fields to scaffold

  return {
    entity,
    entityCamel,
    entityPascal,
    entitySingular,
    table,
    idField,
    fields,
    routes: defaultCrudRoutes(entity, idField),
    middleware: { auth: true, mutation: true },
  };
}

/**
 * Convert Scaffold Architect's simplified JSON output into a full ScaffoldConfig.
 * The architect outputs a minimal format; this expands it into what the engine needs.
 */
export function parseArchitectOutput(json: {
  entity: string;
  table: string;
  fields: Array<{
    name: string;
    type: 'text' | 'integer' | 'real';
    required: boolean;
    enum?: string[];
    foreignKey?: string;
  }>;
  auth?: boolean;
  mutation?: boolean;
}): ScaffoldConfig {
  const entity = json.entity.toLowerCase(); // ensure kebab-case
  const entityCamel = kebabToCamel(entity);
  const entityPascal = kebabToPascal(entity);
  const entitySingular = entityCamel.replace(/s$/, '');
  const table = json.table || entityPascal;
  const idField = entitySingular + 'Id';

  const fields: ScaffoldField[] = json.fields.map(f => {
    const zodType = f.enum
      ? `z.enum([${f.enum.map(v => `'${v}'`).join(', ')}])`
      : f.type === 'integer' || f.type === 'real'
        ? 'z.number()'
        : 'z.string()';
    const tsType = f.type === 'integer' || f.type === 'real' ? 'number' : 'string';

    return {
      name: f.name,
      type: f.type,
      zodType: f.required ? zodType : `${zodType}.nullable()`,
      tsType: f.required ? tsType : `${tsType} | null`,
      notNull: f.required,
    };
  });

  return {
    entity,
    entityCamel,
    entityPascal,
    entitySingular,
    table,
    idField,
    fields,
    routes: defaultCrudRoutes(entity, idField),
    middleware: {
      auth: json.auth !== false,
      mutation: json.mutation !== false,
    },
  };
}

// ────────────────────── Helpers ──────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function kebabToPascal(s: string): string {
  const camel = kebabToCamel(s);
  return capitalize(camel);
}

// ────────────────────── Vitest Service Test Scaffold ──────────────────────

/**
 * Generate a Vitest test file for a CRUD API service.
 * Tests each handler with a mocked Kysely query builder chain.
 * Zero LLM usage — deterministic from ScaffoldConfig.
 */
export function generateServiceTest(config: ScaffoldConfig, template: ScaffoldTemplate = SHOP_DIARY_TEMPLATE): { path: string; content: string } {
  const testPath = `api/src/services/${config.entity}/${config.entity}.service.test.ts`;
  const serviceName = `${config.entityCamel}Service`;
  const idField = config.idField;
  const table = config.table;

  // Build mock return row
  const mockRow: string[] = [`    ${idField}: 'test-id-1'`];
  for (const f of config.fields) {
    const val = f.tsType === 'number' ? '42' : `'test-${f.name}'`;
    mockRow.push(`    ${f.name}: ${val}`);
  }
  const mockRowStr = mockRow.join(',\n');

  // Build create payload (without id)
  const createPayload: string[] = [];
  for (const f of config.fields) {
    const val = f.tsType === 'number' ? '42' : `'test-${f.name}'`;
    createPayload.push(`    ${f.name}: ${val}`);
  }
  const createPayloadStr = createPayload.join(',\n');

  const content = `import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock Kysely query builder chain ─────────────────────────────
// Each method returns \`this\` so chains like .selectFrom().where().selectAll().execute() work.
const mockExecute = vi.fn();
const mockExecuteTakeFirstOrThrow = vi.fn();

const mockQueryBuilder: any = {
  selectFrom: vi.fn().mockReturnThis(),
  insertInto: vi.fn().mockReturnThis(),
  updateTable: vi.fn().mockReturnThis(),
  deleteFrom: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  selectAll: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
  returningAll: vi.fn().mockReturnThis(),
  execute: mockExecute,
  executeTakeFirstOrThrow: mockExecuteTakeFirstOrThrow,
};

vi.mock('${template.imports.db}', () => ({
  db: () => mockQueryBuilder,
}));

vi.mock('ulidx', () => ({
  ulid: () => 'mock-ulid-001',
}));

// Import service after mocks are set up
const { ${serviceName} } = await import('./${config.entity}.service');

const mockEnv = {} as any;
const TEST_ROW = {
${mockRowStr}
};

describe('${serviceName}', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const service = ${serviceName}(mockEnv);

  describe('getAll', () => {
    it('should query ${table} and return all rows', async () => {
      mockExecute.mockResolvedValueOnce([TEST_ROW]);
      const result = await service.getAll${config.entityPascal ? config.entityPascal : ''}();
      expect(mockQueryBuilder.selectFrom).toHaveBeenCalledWith('${table}');
      expect(mockQueryBuilder.selectAll).toHaveBeenCalled();
      expect(mockExecute).toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('should query ${table} by ${idField}', async () => {
      mockExecuteTakeFirstOrThrow.mockResolvedValueOnce(TEST_ROW);
      const result = await service.get${config.entityPascal}ById('test-id-1');
      expect(mockQueryBuilder.selectFrom).toHaveBeenCalledWith('${table}');
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('${idField}', '=', 'test-id-1');
      expect(mockExecuteTakeFirstOrThrow).toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('should insert into ${table} with generated id', async () => {
      mockExecute.mockResolvedValueOnce(undefined);
      await service.create${config.entityPascal}({
${createPayloadStr}
      } as any);
      expect(mockQueryBuilder.insertInto).toHaveBeenCalledWith('${table}');
      expect(mockQueryBuilder.values).toHaveBeenCalledWith(
        expect.objectContaining({ ${idField}: 'mock-ulid-001' })
      );
      expect(mockExecute).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('should update ${table} by ${idField}', async () => {
      mockExecute.mockResolvedValueOnce([{ ...TEST_ROW, ${config.fields[0]?.name || 'name'}: 'updated' }]);
      await service.update${config.entityPascal}('test-id-1', { ${config.fields[0]?.name || 'name'}: 'updated' } as any);
      expect(mockQueryBuilder.updateTable).toHaveBeenCalledWith('${table}');
      expect(mockQueryBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({ ${config.fields[0]?.name || 'name'}: 'updated' })
      );
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('${idField}', '=', 'test-id-1');
      expect(mockExecute).toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('should delete from ${table} by ${idField}', async () => {
      // Mock getById for existence check
      mockExecuteTakeFirstOrThrow.mockResolvedValueOnce(TEST_ROW);
      mockExecute.mockResolvedValueOnce(undefined);
      await service.delete${config.entityPascal}('test-id-1');
      expect(mockQueryBuilder.deleteFrom).toHaveBeenCalledWith('${table}');
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('${idField}', '=', 'test-id-1');
    });
  });
});
`;

  return { path: testPath, content };
}

/**
 * Generate test files for a scaffold config.
 * Returns an array of file objects to write.
 */
export function generateScaffoldTests(config: ScaffoldConfig, template: ScaffoldTemplate = SHOP_DIARY_TEMPLATE): Array<{ path: string; content: string }> {
  return [generateServiceTest(config, template)];
}

// ────────────────────── Tamagui Frontend Scaffold ──────────────────────

/**
 * Frontend scaffold config — describes a CRUD UI feature (screen + dialogs + hooks).
 * Mirrors ScaffoldConfig but for the Tamagui/React side.
 */
export interface FrontendScaffoldConfig {
  entity: string;          // kebab-case: "payment-types"
  entityCamel: string;     // "paymentTypes"
  entityPascal: string;    // "PaymentTypes"
  entitySingular: string;  // "paymentType"
  entityHuman: string;     // "Payment Types" (display name)
  apiPath: string;         // "/payment-types" (API route prefix)
  fields: FrontendField[];
  hasEdit: boolean;
  hasDelete: boolean;
}

export interface FrontendField {
  name: string;          // "categoryName"
  label: string;         // "Name"
  type: 'text' | 'number' | 'select' | 'icon' | 'date';
  required?: boolean;
}

export interface FrontendScaffoldOutput {
  files: Array<{ path: string; content: string }>;
}

/**
 * Generate a full Tamagui frontend feature: screen, add dialog, edit dialog, and API hook.
 * Templates match the exact patterns used in shop-diary-v3 (categories, items, users).
 */
export function generateFrontendScaffold(config: FrontendScaffoldConfig): FrontendScaffoldOutput {
  const files: FrontendScaffoldOutput['files'] = [];

  // 1. API hook: packages/app/apiHooks/use{EntityPascal}.ts
  files.push({
    path: `packages/app/apiHooks/use${config.entityPascal}.ts`,
    content: generateApiHook(config),
  });

  // 2. Screen: packages/app/dashboard/{entity}/screen.tsx
  files.push({
    path: `packages/app/dashboard/${config.entity}/screen.tsx`,
    content: generateScreen(config),
  });

  // 3. Add dialog: packages/app/dashboard/{entity}/dialogs/Add{Pascal}Dialog.tsx
  files.push({
    path: `packages/app/dashboard/${config.entity}/dialogs/Add${config.entityPascal}Dialog.tsx`,
    content: generateAddDialog(config),
  });

  // 4. Edit dialog: packages/app/dashboard/{entity}/dialogs/Edit{Pascal}Dialog.tsx
  if (config.hasEdit) {
    files.push({
      path: `packages/app/dashboard/${config.entity}/dialogs/Edit${config.entityPascal}Dialog.tsx`,
      content: generateEditDialog(config),
    });
  }

  return { files };
}

// ─── Frontend file generators ───────────────────────────────────────

function generateApiHook(c: FrontendScaffoldConfig): string {
  return `import { useQuery } from '@tanstack/react-query'
import { useUserStore } from 'app/store/useUserStore'
import { T${c.entityPascal} } from 'app/types/db.types'
import { fetcherWithToken } from 'app/utils/fetcherWithToken'

const use${c.entityPascal} = () => {
  const token = useUserStore((s) => s.token)

  const { data: ${c.entityCamel} } = useQuery<T${c.entityPascal}[]>({
    queryKey: ['${c.entityCamel}'],
    queryFn: () => fetcherWithToken({ url: '${c.apiPath}' }),
    enabled: Boolean(token),
  })

  return { ${c.entityCamel} }
}

export { use${c.entityPascal} }
`;
}

function generateScreen(c: FrontendScaffoldConfig): string {
  const editImport = c.hasEdit
    ? `import Edit${c.entityPascal}Dialog from 'app/dashboard/${c.entity}/dialogs/Edit${c.entityPascal}Dialog'\n`
    : '';
  const editState = c.hasEdit
    ? `  const [selected, setSelected] = useState<T${c.entityPascal} | null>(null)\n  const [openEditDialog, setOpenEditDialog] = useState(false)\n`
    : '';
  const editHandlers = c.hasEdit
    ? `\n  const handleEditSuccess = () => {\n    queryClient.invalidateQueries({ queryKey: ['${c.entityCamel}'] })\n    setOpenEditDialog(false)\n    setSelected(null)\n  }\n`
    : '';

  // Build column defs for each field
  const fieldColumns = c.fields.map(f =>
    `    columnHelper.accessor('${f.name}', {\n      header: '${f.label}',\n      cell: (info) => info.cell.getValue(),\n    }),`
  ).join('\n');

  const editButton = c.hasEdit
    ? `            <IconButton
              size="$2.5"
              bg="$blue10Light"
              hoverStyle={{ bg: '$blue9Light' }}
              onPress={() => {
                setSelected(info.row.original)
                setOpenEditDialog(true)
              }}
            >
              <Settings size="$icon.sm" color="white" />
            </IconButton>`
    : '';

  const deleteButton = c.hasDelete
    ? `            <IconButton
              size="$2.5"
              bg="$red11Light"
              hoverStyle={{ bg: '$red9Light' }}
              onPress={() => triggerDelete({ id: info.getValue() } as any)}
            >
              <Trash2 size="$icon.sm" color="white" />
            </IconButton>`
    : '';

  const editDialogJsx = c.hasEdit
    ? `\n      <SimpleDialog
        open={openEditDialog}
        onOpenChange={(open) => {
          setOpenEditDialog(open)
          if (!open) setSelected(null)
        }}
        title="Edit ${c.entityHuman}"
      >
        {selected && (
          <Edit${c.entityPascal}Dialog
            ${c.entitySingular}={selected}
            onSuccess={handleEditSuccess}
          />
        )}
      </SimpleDialog>`
    : '';

  const idField = c.entitySingular + 'Id';

  return `import Button from '@shop-diary/ui/src/atoms/Button'
import DashboardLayout from '@shop-diary/ui/src/templates/DashboardLayout'
import { H2, Paragraph, Spacer, XStack, YStack } from 'tamagui'
import SimpleDialog from '@shop-diary/ui/src/molecules/SimpleDialog'
import AdvancedTable from '@shop-diary/ui/src/organisms/AdvancedTable'
import { Plus${c.hasEdit ? ', Settings' : ''}${c.hasDelete ? ', Trash2' : ''} } from '@tamagui/lucide-icons'
import Add${c.entityPascal}Dialog from 'app/dashboard/${c.entity}/dialogs/Add${c.entityPascal}Dialog'
${editImport}import { use${c.entityPascal} } from 'app/apiHooks/use${c.entityPascal}'
import { memo, useState } from 'react'
import IconButton from '@shop-diary/ui/src/atoms/IconButton'
import { ColumnDef, createColumnHelper } from '@tanstack/react-table'
import { T${c.entityPascal} } from 'app/types/db.types'
import { fetcherWithToken } from 'app/utils/fetcherWithToken'
import useSWRMutation from 'swr/mutation'
import { useQueryClient } from '@tanstack/react-query'

const columnHelper = createColumnHelper<T${c.entityPascal}>()

const ${c.entityPascal} = () => {
  const { ${c.entityCamel} } = use${c.entityPascal}()
  const queryClient = useQueryClient()
${editState}${c.hasDelete ? `  const { trigger: triggerDelete } = useSWRMutation('${c.apiPath}/', (url, { arg }: any) =>\n    fetcherWithToken({ method: 'DELETE', url: url + arg.id })\n  )\n` : ''}${editHandlers}
  const columns = [
${fieldColumns}
    columnHelper.accessor('${idField}', {
      header: 'Actions',
      cell: (info) => {
        return (
          <XStack gap="$2">
${editButton}
${deleteButton}
          </XStack>
        )
      },
    }),
  ] as ColumnDef<unknown, any>[]

  return (
    <DashboardLayout active="${c.entity}">
      <XStack jc="space-between" ai="flex-end" fw="wrap" gap="$3" px="$5" pt="$5" $sm={{ px: '$2', pt: '$2', ai: 'flex-start' }}>
        <YStack gap="$2">
          <H2 color="white">${c.entityHuman}</H2>
          <Paragraph color="rgba(255,255,255,0.72)">
            Manage ${c.entityHuman.toLowerCase()}.
          </Paragraph>
        </YStack>
        <XStack gap="$3" $sm={{ w: '100%' }}>
          <SimpleDialog
            triggerElement={
              <Button size="$0.75" icon={<Plus size="$space.4" color="white" />} $sm={{ w: '100%' }}>
                Add ${c.entityHuman}
              </Button>
            }
            title="Add ${c.entityHuman}"
          >
            <Add${c.entityPascal}Dialog />
          </SimpleDialog>
        </XStack>
      </XStack>
      <Spacer size="$3" />
      {${c.entityCamel} && <AdvancedTable data={${c.entityCamel}} columns={columns} />}${editDialogJsx}
    </DashboardLayout>
  )
}

export default memo(${c.entityPascal})
`;
}

function generateAddDialog(c: FrontendScaffoldConfig): string {
  const formFields = c.fields.filter(f => f.type !== 'date');
  const fieldDefaults = formFields.map(f =>
    `      ${f.name}: ${f.type === 'number' ? '0' : "''"},`
  ).join('\n');

  const fieldInputs = formFields.map(f => {
    if (f.type === 'icon') {
      return `          <Fieldset>\n            <Label>${f.label}</Label>\n            <IconSelectionController control={control} name="${f.name}" />\n          </Fieldset>`;
    }
    return `          <Fieldset>\n            <Label>${f.label}</Label>\n            <TextInputController control={control} name="${f.name}" />\n          </Fieldset>`;
  }).join('\n');

  const formType = `IAdd${c.entityPascal}Form`;
  const formInterface = formFields.map(f =>
    `  ${f.name}: ${f.type === 'number' ? 'number' : 'string'}`
  ).join('\n');

  const hasIcon = formFields.some(f => f.type === 'icon');

  return `import * as icons from '@tamagui/lucide-icons'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { TNew${c.entityPascal} } from 'app/types/db.types'
import React, { memo } from 'react'
import { useForm } from 'react-hook-form'
import { Dialog, Fieldset, Form, Label, XStack } from 'tamagui'
import Button from '@shop-diary/ui/src/atoms/Button'
${hasIcon ? "import IconSelectionController from '@shop-diary/ui/src/molecules/IconSelectionController'\n" : ''}import TextInputController from '@shop-diary/ui/src/organisms/TextInputController'
import { fetcherWithToken } from 'app/utils/fetcherWithToken'
import { useUserStore } from 'app/store/useUserStore'

interface ${formType} {
${formInterface}
}

const Add${c.entityPascal}Dialog: React.FC = () => {
  const { handleSubmit, control, reset } = useForm<${formType}>({
    defaultValues: {
${fieldDefaults}
    },
  })

  const token = useUserStore((s) => s.token)
  const queryClient = useQueryClient()

  const { mutate } = useMutation<{}, Error, TNew${c.entityPascal}>({
    mutationFn: (data) =>
      fetcherWithToken({
        method: 'POST',
        url: '${c.apiPath}/create',
        data,
        token: token ?? '',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['${c.entityCamel}'] })
      reset()
    },
  })

  return (
    <>
      <Form onSubmit={handleSubmit((data) => mutate(data as any))}>
        <Fieldset gap="$5">
${fieldInputs}
        </Fieldset>
        <XStack als="flex-end" pt="$2">
          <Dialog.Close displayWhenAdapted asChild>
            <Form.Trigger asChild>
              <Button space="$1" scaleIcon={1.5} icon={<icons.Save color="white" />}>
                Save
              </Button>
            </Form.Trigger>
          </Dialog.Close>
        </XStack>
      </Form>
    </>
  )
}

export default memo(Add${c.entityPascal}Dialog)
`;
}

function generateEditDialog(c: FrontendScaffoldConfig): string {
  const formFields = c.fields.filter(f => f.type !== 'date');
  const fieldInputs = formFields.map(f => {
    if (f.type === 'icon') {
      return `          <Fieldset>\n            <Label>${f.label}</Label>\n            <IconSelectionController control={control} name="${f.name}" />\n          </Fieldset>`;
    }
    return `          <Fieldset>\n            <Label>${f.label}</Label>\n            <TextInputController control={control} name="${f.name}" />\n          </Fieldset>`;
  }).join('\n');

  const formType = `IEdit${c.entityPascal}Form`;
  const formInterface = formFields.map(f =>
    `  ${f.name}: ${f.type === 'number' ? 'number' : 'string'}`
  ).join('\n');

  const hasIcon = formFields.some(f => f.type === 'icon');
  const idField = c.entitySingular + 'Id';

  return `import * as icons from '@tamagui/lucide-icons'
import { useMutation } from '@tanstack/react-query'
import { T${c.entityPascal} } from 'app/types/db.types'
import React, { memo } from 'react'
import { useForm } from 'react-hook-form'
import { Dialog, Fieldset, Form, Label, XStack } from 'tamagui'
import Button from '@shop-diary/ui/src/atoms/Button'
${hasIcon ? "import IconSelectionController from '@shop-diary/ui/src/molecules/IconSelectionController'\n" : ''}import TextInputController from '@shop-diary/ui/src/organisms/TextInputController'
import { fetcherWithToken } from 'app/utils/fetcherWithToken'
import { useUserStore } from 'app/store/useUserStore'

interface IEdit${c.entityPascal}DialogProps {
  ${c.entitySingular}: T${c.entityPascal}
  onSuccess: () => void
}

interface ${formType} {
${formInterface}
}

const Edit${c.entityPascal}Dialog: React.FC<IEdit${c.entityPascal}DialogProps> = ({ ${c.entitySingular}, onSuccess }) => {
  const { handleSubmit, control } = useForm<${formType}>({
    defaultValues: {
${formFields.map(f => `      ${f.name}: ${c.entitySingular}.${f.name},`).join('\n')}
    },
  })

  const token = useUserStore((s) => s.token)

  const { mutate } = useMutation<{}, Error, ${formType}>({
    mutationFn: (data) =>
      fetcherWithToken({
        method: 'PUT',
        url: '${c.apiPath}/' + ${c.entitySingular}.${idField},
        data,
        token: token ?? '',
      }),
    onSuccess,
  })

  return (
    <>
      <Form onSubmit={handleSubmit((data) => mutate(data))}>
        <Fieldset gap="$5">
${fieldInputs}
        </Fieldset>
        <XStack als="flex-end" pt="$2">
          <Dialog.Close displayWhenAdapted asChild>
            <Form.Trigger asChild>
              <Button space="$1" scaleIcon={1.5} icon={<icons.Save color="white" />}>
                Update
              </Button>
            </Form.Trigger>
          </Dialog.Close>
        </XStack>
      </Form>
    </>
  )
}

export default memo(Edit${c.entityPascal}Dialog)
`;
}

// ─── Frontend scaffold detection ────────────────────────────────────

/**
 * Detect if an issue matches a frontend scaffold pattern.
 * Converts a ScaffoldConfig (API-side) into a FrontendScaffoldConfig.
 */
export function apiConfigToFrontendConfig(
  apiConfig: ScaffoldConfig,
  humanName?: string
): FrontendScaffoldConfig {
  return {
    entity: apiConfig.entity,
    entityCamel: apiConfig.entityCamel,
    entityPascal: apiConfig.entityPascal,
    entitySingular: apiConfig.entitySingular,
    entityHuman: humanName || apiConfig.entityPascal.replace(/([A-Z])/g, ' $1').trim(),
    apiPath: '/' + apiConfig.entity,
    fields: apiConfig.fields
      .filter(f => !f.primaryKey && f.name !== 'shopId' && f.name !== 'createdAt' && f.name !== 'updatedAt')
      .map(f => ({
        name: f.name,
        label: capitalize(f.name.replace(/([A-Z])/g, ' $1').trim()),
        type: (f.tsType === 'number' ? 'number' : 'text') as FrontendField['type'],
        required: f.notNull,
      })),
    hasEdit: true,
    hasDelete: true,
  };
}

/**
 * Generate both API + frontend scaffolds from a single ScaffoldConfig.
 * Returns combined file list for the full-stack feature.
 */
export function generateFullStackScaffold(
  config: ScaffoldConfig,
  template: ScaffoldTemplate = SHOP_DIARY_TEMPLATE,
  humanName?: string
): { api: ScaffoldOutput; frontend: FrontendScaffoldOutput; tests: Array<{ path: string; content: string }> } {
  const api = generateScaffold(config, template);
  const frontendConfig = apiConfigToFrontendConfig(config, humanName);
  const frontend = generateFrontendScaffold(frontendConfig);
  const tests = generateScaffoldTests(config, template);
  return { api, frontend, tests };
}
