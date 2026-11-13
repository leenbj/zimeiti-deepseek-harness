/**
 * tool-kit.js — the two first-party helpers this plugin would normally import, reimplemented so the
 * package stays dependency-free.
 *
 * Why: this plugin is installed into a profile as a linked/packed package; a bare
 * `import ... from '@deepseek-ai/dsh-tools'` inside the bundle would not resolve from the profile and
 * the whole entry would fail to activate. The contract below mirrors the host's `defineTool`: a
 * registry-ready definition is `{ name, description, parameters, output: { schema, render }, execute }`
 * where both schemas are plain JSON Schema limited to the host's supported keyword subset.
 *
 * @module ego-publish/tool-kit
 */

/** Keywords the host's schema assertion accepts. Anything else must not be emitted. */
const SUPPORTED_SCHEMA_KEYS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'oneOf',
  'description', 'title', 'default',
]);

/**
 * Normalize authoring sugar into strict JSON Schema.
 *
 * Sugar: a property may carry `required: true`, and an object-typed property may omit `properties`.
 * Emitted: a plain schema with `required` lifted into an array on the object that owns the properties.
 *
 * @param {Record<string, any>} spec - authoring spec for one value.
 * @returns {Record<string, unknown>} JSON Schema for that value.
 */
function normalizeSchema(spec) {
  if (!spec || typeof spec !== 'object') return {};

  /** @type {Record<string, unknown>} */
  const out = {};
  if (spec.type) out.type = spec.type;
  if (spec.description) out.description = spec.description;
  if (spec.title) out.title = spec.title;
  if (spec.enum) out.enum = [...spec.enum];
  if (spec.const !== undefined) out.const = spec.const;
  if (spec.default !== undefined) out.default = spec.default;
  if (spec.oneOf) out.oneOf = spec.oneOf.map(normalizeSchema);

  if (spec.type === 'array') {
    out.items = normalizeSchema(spec.items ?? {});
    return out;
  }

  if (spec.type === 'object' || spec.properties) {
    out.type = 'object';
    /** @type {Record<string, unknown>} */
    const properties = {};
    /** @type {string[]} */
    const required = [];
    for (const [name, sub] of Object.entries(spec.properties ?? {})) {
      properties[name] = normalizeSchema(sub);
      if (sub && sub.required === true) required.push(name);
    }
    out.properties = properties;
    if (required.length) out.required = required;
    out.additionalProperties = spec.additionalProperties ?? false;
    return out;
  }

  return out;
}

/**
 * Assert a schema stays inside the host's supported subset, so a mistake surfaces at import time
 * rather than at the first model call.
 * @param {unknown} schema
 * @param {string} path
 */
export function assertSupportedSchema(schema, path = 'schema') {
  if (schema === null || typeof schema !== 'object') return;
  if (Array.isArray(schema)) {
    schema.forEach((item, index) => assertSupportedSchema(item, `${path}[${index}]`));
    return;
  }
  for (const [key, value] of Object.entries(schema)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) throw new Error(`${path}: unsupported JSON Schema keyword "${key}"`);
    if (key === 'properties' && value && typeof value === 'object') {
      for (const [name, sub] of Object.entries(value)) assertSupportedSchema(sub, `${path}.properties.${name}`);
    } else if (key === 'items' || key === 'additionalProperties' || key === 'oneOf') {
      assertSupportedSchema(value, `${path}.${key}`);
    }
  }
}

const TYPE_CHECKS = {
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
  array: (value) => Array.isArray(value),
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
};

/**
 * Validate arguments against a normalized object schema. Returns path-qualified violations; empty means
 * valid. Deliberately small: enough to catch a model mistake with a readable message, not a full
 * JSON Schema engine.
 *
 * @param {Record<string, any>} schema
 * @param {unknown} args
 * @param {string} [prefix]
 * @returns {string[]}
 */
export function validateArgs(schema, args, prefix = '') {
  const violations = [];
  if (!schema || schema.type !== 'object') return violations;
  const value = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const properties = schema.properties ?? {};

  for (const name of schema.required ?? []) {
    if (value[name] === undefined) violations.push(`${prefix}${name} is required`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) violations.push(`${prefix}${key} is not a known argument`);
    }
  }
  for (const [name, sub] of Object.entries(properties)) {
    const item = value[name];
    if (item === undefined) continue;
    const at = `${prefix}${name}`;
    if (sub.type && TYPE_CHECKS[sub.type] && !TYPE_CHECKS[sub.type](item)) {
      const article = sub.type === 'object' || sub.type === 'array' || sub.type === 'integer' ? 'an' : 'a';
      violations.push(`${at} must be ${article} ${sub.type}${item === null ? ' (got null)' : ''}`);
      continue;
    }
    if (sub.enum && !sub.enum.includes(item)) {
      violations.push(`${at} must be one of ${sub.enum.map((v) => JSON.stringify(v)).join(', ')}`);
    }
    if (sub.type === 'array' && sub.items) {
      item.forEach((element, index) => {
        if (sub.items.type === 'object') violations.push(...validateArgs(sub.items, element, `${at}[${index}].`));
        else if (sub.items.enum && !sub.items.enum.includes(element)) {
          violations.push(`${at}[${index}] must be one of ${sub.items.enum.join(', ')}`);
        }
      });
    } else if (sub.type === 'object') {
      violations.push(...validateArgs(sub, item, `${at}.`));
    }
  }
  return violations;
}

/**
 * Build a registry-ready tool definition.
 *
 * @param {object} options
 * @param {string} options.name
 * @param {string} options.description
 * @param {Record<string, any>} options.parameters - authoring specs (may carry `required: true`).
 * @param {{ schema: Record<string, any>, render: (args: any, value: any) => Array<{type:'text',text:string}> }} options.output
 * @param {(args: any, exec: any) => Promise<unknown>} options.execute
 * @param {(args: any) => object} [options.presentCall]
 * @param {boolean} [options.isConcurrencySafe]
 * @param {number} [options.timeoutMs]
 * @returns {object} a definition accepted by `ctx.tools.register`.
 */
export function defineTool(options) {
  /** @type {Record<string, unknown>} */
  const properties = {};
  /** @type {string[]} */
  const required = [];
  for (const [name, sub] of Object.entries(options.parameters ?? {})) {
    properties[name] = normalizeSchema(sub);
    if (sub && sub.required === true) required.push(name);
  }
  const parameters = {
    type: 'object',
    properties,
    additionalProperties: false,
    ...(required.length ? { required } : {}),
  };

  const outputSchema = normalizeSchema(options.output.schema ?? {});

  assertSupportedSchema(parameters, `defineTool(${options.name}).parameters`);
  assertSupportedSchema(outputSchema, `defineTool(${options.name}).output.schema`);
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
  }

  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: (args, value) => options.output.render(args, value),
    },
    async execute(args, exec) {
      const violations = validateArgs(parameters, args);
      if (violations.length > 0) {
        const error = new Error(`invalid arguments: ${violations.join('; ')}`);
        error.code = 'INVALID_ARGS';
        error.violations = violations;
        throw error;
      }
      return options.execute(args, exec);
    },
  };
  if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs;
  if (options.isConcurrencySafe) {
    tool.isConcurrencySafe = (args) => validateArgs(parameters, args).length === 0 && options.isConcurrencySafe(args);
  }
  if (options.presentCall) {
    tool.presentCall = (args) => (validateArgs(parameters, args).length > 0 ? undefined : options.presentCall(args));
  }
  return tool;
}

/**
 * Render a value for the model as one text block: a headline plus the structured payload.
 * @param {string} headline
 * @param {unknown} value
 * @returns {Array<{type:'text',text:string}>}
 */
export function renderValue(headline, value) {
  return [{ type: 'text', text: `${headline}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`` }];
}
