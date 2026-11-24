/**
 * Tool-authoring shim.
 *
 * The host's own `defineTool` lives in `@deepseek-ai/dsh-tools`, which a
 * link-installed plugin cannot resolve (Node resolves from the checkout path,
 * not from the profile that links it). The registry only requires a definition
 * shaped like `{name, description, parameters, output:{schema, render},
 * execute}` with *raw* JSON Schema in `parameters` and `output.schema`
 * (`dsh-tools/src/index.ts` `register()`), so we compile the same authoring
 * specs ourselves and stay dependency-free.
 *
 * Authoring rules mirrored from `dsh-tools/src/schema.ts`:
 * - `required: true` marks a property required and is stripped from the output;
 * - object nodes must state `additionalProperties` explicitly;
 * - annotations are `description`, `title`, `default`, `examples`;
 * - `enum`/`const` ride on a typed scalar, `oneOf` replaces `type`.
 * @module dsh-teamplan/spec
 */

const ANNOTATIONS = ['description', 'title', 'default', 'examples'];
const SCALARS = new Set(['string', 'number', 'integer', 'boolean', 'null']);

function fail(path, message) {
  throw new TypeError(`${path}: ${message}`);
}

function copyAnnotations(from, to) {
  for (const key of ANNOTATIONS) {
    if (Object.hasOwn(from, key)) to[key] = from[key];
  }
}

/** Compile one author-facing value schema into raw JSON Schema. */
export function compileValueSchema(spec, path = 'schema') {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    fail(path, 'must be a value schema object');
  }
  if (Object.hasOwn(spec, 'oneOf')) {
    if (Object.hasOwn(spec, 'type')) fail(path, 'cannot declare both type and oneOf');
    if (!Array.isArray(spec.oneOf) || spec.oneOf.length < 2) fail(path, 'oneOf must list at least two schemas');
    const node = {};
    copyAnnotations(spec, node);
    node.oneOf = spec.oneOf.map((branch, index) => compileValueSchema(branch, `${path}.oneOf[${index}]`));
    return node;
  }
  const type = spec.type;
  if (type === 'json') {
    const node = {};
    copyAnnotations(spec, node);
    return node;
  }
  if (type === 'object') {
    if (typeof spec.additionalProperties !== 'boolean') {
      fail(path, 'object schemas must state additionalProperties: true or false');
    }
    const node = { type: 'object' };
    copyAnnotations(spec, node);
    node.additionalProperties = spec.additionalProperties;
    if (spec.properties !== undefined) {
      const compiled = compileProperties(spec.properties, `${path}.properties`);
      node.properties = compiled.properties;
      if (compiled.required.length > 0) node.required = compiled.required;
    }
    return node;
  }
  if (type === 'array') {
    const node = { type: 'array' };
    copyAnnotations(spec, node);
    if (spec.items !== undefined) node.items = compileValueSchema(spec.items, `${path}.items`);
    return node;
  }
  if (typeof type === 'string' && SCALARS.has(type)) {
    const node = { type };
    copyAnnotations(spec, node);
    if (spec.enum !== undefined) node.enum = [...spec.enum];
    if (spec.const !== undefined) node.const = spec.const;
    return node;
  }
  return fail(path, 'type must be string/number/integer/boolean/null/array/object/json, or use oneOf');
}

/** Compile a property map, hoisting each `required: true` into the root list. */
export function compileProperties(spec, path = 'properties') {
  if (spec === null || typeof spec !== 'object') fail(path, 'must be an object of value schemas');
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(spec)) {
    const node = compileValueSchema(value, `${path}.${key}`);
    properties[key] = node;
    if (value?.required === true) required.push(key);
  }
  return { properties, required };
}

/**
 * Compile the implicit parameter object.
 *
 * The parameter root is an open object: unknown keys stay allowed so a caller
 * that passes an extra field gets ignored by validation instead of rejected by
 * the registry.
 */
export function compileParameters(spec, path = 'parameters') {
  const { properties, required } = compileProperties(spec, path);
  const schema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/**
 * Author one tool definition in the host's own style and hand the registry a
 * raw-JSON-Schema definition.
 * @param options - same shape as `@deepseek-ai/dsh-tools` `defineTool`.
 * @returns a `ToolDefinition` ready for `ctx.tools.register`.
 */
export function defineTool(options) {
  const output = options.output;
  if (output === undefined || typeof output.render !== 'function') {
    fail(options?.name ?? 'tool', 'output must declare { schema, render }');
  }
  const definition = {
    name: options.name,
    description: options.description,
    parameters: compileParameters(options.parameters ?? {}),
    output: {
      schema: compileValueSchema(output.schema, `${options.name}.output.schema`),
      render: output.render,
    },
    execute: options.execute,
  };
  if (typeof output.presentationMeta === 'function') definition.output.presentationMeta = output.presentationMeta;
  if (typeof options.presentCall === 'function') definition.presentCall = options.presentCall;
  if (typeof options.presentResult === 'function') definition.presentResult = options.presentResult;
  if (typeof options.isConcurrencySafe === 'function') definition.isConcurrencySafe = options.isConcurrencySafe;
  return definition;
}
