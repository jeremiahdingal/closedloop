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

  return result + '\n';
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
