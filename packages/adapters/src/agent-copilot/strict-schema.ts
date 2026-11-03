import type { ZodType } from 'zod';

type Json = Record<string, unknown>;

/**
 * Structured output uses strict JSON Schema (the SDK sends `strict: true`). OpenAI models then
 * require every property to be listed in `required` and objects to refuse extra keys; an optional
 * field must be nullable instead. Zod's own schema leaves optional fields out of `required`, which
 * these models reject with a 400 ("'required' ... Missing 'repo'"). This rewrites the schema into
 * that strict form; Anthropic models accept it too.
 */
export function strictJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictJsonSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Json = {};
  for (const [k, v] of Object.entries(schema as Json)) {
    // Not part of the strict subset; Tandem applies defaults itself when it parses.
    if (k === 'default' || k === '$schema') continue;
    out[k] = k === 'properties' && v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Json).map(([p, s]) => [p, strictJsonSchema(s)])) : strictJsonSchema(v);
  }
  if (out.properties && typeof out.properties === 'object') {
    const props = out.properties as Json;
    const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);
    for (const [name, prop] of Object.entries(props)) if (!required.has(name)) props[name] = nullable(prop);
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

function nullable(prop: unknown): unknown {
  if (!prop || typeof prop !== 'object') return prop;
  const p = prop as Json;
  if (typeof p.type === 'string') return { ...p, type: [p.type, 'null'] };
  if (Array.isArray(p.type)) return p.type.includes('null') ? p : { ...p, type: [...(p.type as string[]), 'null'] };
  return { anyOf: [p, { type: 'null' }] };
}

/** Drops null object values (strict output's "absent"), so Zod applies optional and default. */
export function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Json)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => [k, dropNulls(v)]),
  );
}

/** What the SDK needs from a response schema: its JSON Schema and a parse function. */
export interface ResponseSchemaLike<T> {
  toJSONSchema(): unknown;
  parse(value: unknown): T;
}

export function strictResponseSchema<T>(schema: ZodType<T>): ResponseSchemaLike<T> {
  return {
    toJSONSchema: () => strictJsonSchema((schema as unknown as { toJSONSchema(): unknown }).toJSONSchema()),
    parse: (value) => schema.parse(dropNulls(value)),
  };
}
