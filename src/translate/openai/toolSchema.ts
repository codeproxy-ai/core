import type { OpenAiChatTool } from '../../types/openai_chat.js';

/**
 * Strip JSON Schema keywords that some OpenAI-compatible upstreams reject.
 */
export function sanitizeJsonSchema(schema: unknown, depth = 0): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 20) {
    return schema;
  }
  // eslint-disable-next-line no-restricted-syntax -- Runtime schema traversal needs unknown narrowing.
  const src = schema as Record<string, unknown>;

  if ('$ref' in src) {
    return src.description ? { description: src.description } : {};
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(src)) {
    if (isDroppedSchemaKeyword(key)) {
      continue;
    }
    if (key === 'properties' && val && typeof val === 'object' && !Array.isArray(val)) {
      const props: Record<string, unknown> = {};
      // eslint-disable-next-line no-restricted-syntax -- Runtime schema traversal needs unknown narrowing.
      for (const [propName, propSchema] of Object.entries(val as Record<string, unknown>)) {
        props[propName] = sanitizeJsonSchema(propSchema, depth + 1);
      }
      out[key] = props;
    } else if (key === 'additionalProperties') {
      if (typeof val !== 'boolean') {
        out[key] = sanitizeJsonSchema(val, depth + 1);
      }
    } else if (key === 'items') {
      out[key] = sanitizeJsonSchema(val, depth + 1);
    } else if (isSchemaCompositionKeyword(key) && Array.isArray(val)) {
      out[key] = val.map((schemaItem) => sanitizeJsonSchema(schemaItem, depth + 1));
    } else {
      out[key] = val;
    }
  }
  return out;
}

export function getValidFunctionNames(tools: OpenAiChatTool[]): Set<string> | undefined {
  const names = new Set<string>();
  for (const tool of tools) {
    // eslint-disable-next-line no-restricted-syntax -- OpenAiChatTool is intentionally extensible.
    const maybeTool = tool as { type?: unknown; function?: { name?: unknown } };
    if (maybeTool.type === 'function' && typeof maybeTool.function?.name === 'string') {
      names.add(maybeTool.function.name);
    }
  }
  return names.size ? names : undefined;
}

function isDroppedSchemaKeyword(key: string): boolean {
  return (
    key === '$schema' ||
    key === '$defs' ||
    key === 'definitions' ||
    key === '$id' ||
    key === '$anchor' ||
    key === '$comment'
  );
}

function isSchemaCompositionKeyword(key: string): boolean {
  return key === 'anyOf' || key === 'oneOf' || key === 'allOf' || key === 'not';
}
