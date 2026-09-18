/**
 * Whether a tool schema is a plain JSON Schema object, as opposed to a
 * Zod / Standard Schema or an AI SDK `Schema` wrapper. Frameworks validate
 * the model's input against Zod schemas themselves but pass JSON Schema
 * input through unchecked, so plain JSON Schemas are also sent to klanex as
 * the server-side payload gate.
 */
export function isPlainJsonSchema(schema: unknown): schema is Record<string, unknown> {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return false;
  return !("~standard" in schema) && !("_def" in schema) && !("_zod" in schema) && !("jsonSchema" in schema);
}
