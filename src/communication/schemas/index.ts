/**
 * Claude Team - JSON Schema Registry
 *
 * Loads and validates message payloads against JSON schemas.
 * Provides runtime validation without external dependencies.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MessageType } from '../../shared/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// SCHEMA LOADING
// ============================================================

function loadSchema(filename: string): object {
  const schemaPath = path.join(__dirname, filename);
  const content = fs.readFileSync(schemaPath, 'utf-8');
  return JSON.parse(content);
}

/** Map of message types to their JSON schemas. */
export const SCHEMAS: Record<MessageType, object> = {
  task_assignment: loadSchema('task-assignment.schema.json'),
  status_report: loadSchema('status-report.schema.json'),
  review_request: loadSchema('review-request.schema.json'),
  review_result: loadSchema('review-result.schema.json'),
  escalation: loadSchema('escalation.schema.json'),
  artifact_handoff: loadSchema('artifact-handoff.schema.json'),
  gate_result: loadSchema('gate-result.schema.json'),
};

/**
 * Get the JSON schema for a specific message type.
 */
export function getSchema(type: MessageType): object {
  const schema = SCHEMAS[type];
  if (!schema) {
    throw new Error(`No schema found for message type: ${type}`);
  }
  return schema;
}

// ============================================================
// VALIDATION
// ============================================================

interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

/** Minimal JSON Schema object shape for structural validation. */
interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  items?: JsonSchemaObject;
}

/**
 * Validate a payload against its message type schema.
 * Uses manual structural validation (no external JSON schema validator).
 */
export function validateWithSchema(type: MessageType, payload: unknown): ValidationResult {
  const schema = SCHEMAS[type] as JsonSchemaObject;

  if (!schema) {
    return { valid: false, errors: [`Unknown message type: ${type}`] };
  }

  const errors: string[] = [];

  // Type check
  if (typeof payload !== 'object' || payload === null) {
    return { valid: false, errors: ['Payload must be an object'] };
  }

  const data = payload as Record<string, unknown>;
  const props = schema.properties || {};
  const required = schema.required || [];

  // Check required fields
  for (const field of required) {
    if (!(field in data)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Validate each property
  for (const [key, value] of Object.entries(data)) {
    const propSchema = props[key];

    if (!propSchema) {
      if (schema.additionalProperties === false) {
        errors.push(`Unknown field: ${key}`);
      }
      continue;
    }

    const result = validateProperty(key, value, propSchema);
    if (!result.valid && result.errors) {
      errors.push(...result.errors);
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Validate a single property against its schema definition.
 */
function validateProperty(key: string, value: unknown, propSchema: JsonSchemaObject): ValidationResult {
  const errors: string[] = [];

  // Type validation
  if (propSchema.type) {
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (actualType !== propSchema.type) {
      errors.push(`Field '${key}' must be of type ${propSchema.type}, got ${actualType}`);
      return { valid: false, errors };
    }
  }

  // Enum validation
  if (propSchema.enum && !propSchema.enum.includes(value)) {
    errors.push(`Field '${key}' must be one of: ${propSchema.enum.join(', ')}, got '${value}'`);
  }

  // Number range validation
  if (typeof value === 'number') {
    if (propSchema.minimum !== undefined && value < propSchema.minimum) {
      errors.push(`Field '${key}' must be >= ${propSchema.minimum}, got ${value}`);
    }
    if (propSchema.maximum !== undefined && value > propSchema.maximum) {
      errors.push(`Field '${key}' must be <= ${propSchema.maximum}, got ${value}`);
    }
  }

  // Array validation
  if (Array.isArray(value) && propSchema.items) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      const itemType = typeof item;
      if (propSchema.items.type && itemType !== propSchema.items.type) {
        errors.push(`Field '${key}[${i}]' must be of type ${propSchema.items.type}, got ${itemType}`);
      }
    }
  }

  // Object validation (nested properties)
  if (propSchema.type === 'object' && typeof value === 'object' && value !== null) {
    const nestedProps = propSchema.properties || {};
    const nestedRequired = propSchema.required || [];
    const nestedData = value as Record<string, unknown>;

    // Check required nested fields
    for (const field of nestedRequired) {
      if (!(field in nestedData)) {
        errors.push(`Field '${key}.${field}' is required`);
      }
    }

    // Validate nested properties
    for (const [nestedKey, nestedValue] of Object.entries(nestedData)) {
      const nestedPropSchema = nestedProps[nestedKey];

      if (!nestedPropSchema) {
        if (propSchema.additionalProperties === false) {
          errors.push(`Unknown field: ${key}.${nestedKey}`);
        }
        continue;
      }

      const result = validateProperty(`${key}.${nestedKey}`, nestedValue, nestedPropSchema);
      if (!result.valid && result.errors) {
        errors.push(...result.errors);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}
