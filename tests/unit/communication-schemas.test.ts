/**
 * Tests for JSON Schema validation of message payloads.
 */

import { describe, it, expect } from 'vitest';
import { SCHEMAS, getSchema, validateWithSchema } from '../../src/communication/schemas/index.js';
import type { MessageType } from '../../src/shared/types.js';

describe('Communication Schemas', () => {
  describe('Schema Loading', () => {
    it('should load all 7 schemas', () => {
      const expectedTypes: MessageType[] = [
        'task_assignment',
        'status_report',
        'review_request',
        'review_result',
        'escalation',
        'artifact_handoff',
        'gate_result',
      ];

      for (const type of expectedTypes) {
        expect(SCHEMAS[type]).toBeDefined();
        expect(SCHEMAS[type]).toHaveProperty('$schema');
        expect(SCHEMAS[type]).toHaveProperty('title');
        expect(SCHEMAS[type]).toHaveProperty('type', 'object');
      }
    });

    it('should retrieve schema by type using getSchema', () => {
      const schema = getSchema('task_assignment');
      expect(schema).toBeDefined();
      expect(schema).toHaveProperty('title', 'TaskAssignmentPayload');
    });

    it('should throw error for unknown message type', () => {
      expect(() => getSchema('unknown' as MessageType)).toThrow('No schema found');
    });
  });

  describe('TaskAssignment Validation', () => {
    it('should validate valid task assignment', () => {
      const payload = {
        taskId: 'task-123',
        subject: 'Implement login feature',
        description: 'Add OAuth login with Google',
        fileOwnership: ['src/auth/**'],
        priority: 1,
        sprintId: 'sprint-1',
        dagNodeId: 'node-42',
      };

      const result = validateWithSchema('task_assignment', payload);
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should reject missing required fields', () => {
      const payload = {
        taskId: 'task-123',
        subject: 'Test',
        // Missing description, fileOwnership, priority
      };

      const result = validateWithSchema('task_assignment', payload);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: description');
      expect(result.errors).toContain('Missing required field: fileOwnership');
      expect(result.errors).toContain('Missing required field: priority');
    });

    it('should validate optional fields', () => {
      const payload = {
        taskId: 'task-123',
        subject: 'Test',
        description: 'Test task',
        fileOwnership: [],
        priority: 3,
      };

      const result = validateWithSchema('task_assignment', payload);
      expect(result.valid).toBe(true);
    });

    it('should validate priority range', () => {
      const payload = {
        taskId: 'task-123',
        subject: 'Test',
        description: 'Test task',
        fileOwnership: [],
        priority: 10, // Invalid: max is 5
      };

      const result = validateWithSchema('task_assignment', payload);
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.includes('priority'))).toBe(true);
    });
  });

  describe('StatusReport Validation', () => {
    it('should validate valid status report', () => {
      const payload = {
        taskId: 'task-123',
        status: 'in-progress',
        progress: 50,
        summary: 'Completed authentication module',
        filesModified: ['src/auth/login.ts', 'src/auth/oauth.ts'],
      };

      const result = validateWithSchema('status_report', payload);
      expect(result.valid).toBe(true);
    });

    it('should enforce status enum', () => {
      const payload = {
        taskId: 'task-123',
        status: 'invalid-status',
        progress: 50,
        summary: 'Test',
      };

      const result = validateWithSchema('status_report', payload);
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.includes('status'))).toBe(true);
    });

    it('should validate progress range', () => {
      const payload = {
        taskId: 'task-123',
        status: 'in-progress',
        progress: 150, // Invalid: max is 100
        summary: 'Test',
      };

      const result = validateWithSchema('status_report', payload);
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.includes('progress'))).toBe(true);
    });

    it('should accept blocked status with blocker description', () => {
      const payload = {
        taskId: 'task-123',
        status: 'blocked',
        progress: 30,
        summary: 'Blocked by API availability',
        blockerDescription: 'Waiting for backend API endpoint to be deployed',
      };

      const result = validateWithSchema('status_report', payload);
      expect(result.valid).toBe(true);
    });
  });

  describe('ReviewRequest Validation', () => {
    it('should validate valid review request', () => {
      const payload = {
        taskId: 'task-123',
        artifactPath: 'src/auth/login.ts',
        artifactType: 'api-spec',
        reviewType: 'code-review',
        changedFiles: ['src/auth/login.ts', 'tests/auth.test.ts'],
        description: 'Please review the new authentication implementation',
      };

      const result = validateWithSchema('review_request', payload);
      expect(result.valid).toBe(true);
    });

    it('should enforce artifactType enum', () => {
      const payload = {
        taskId: 'task-123',
        artifactPath: 'src/test.ts',
        artifactType: 'invalid-type',
        reviewType: 'code-review',
        changedFiles: ['src/test.ts'],
        description: 'Test',
      };

      const result = validateWithSchema('review_request', payload);
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.includes('artifactType'))).toBe(true);
    });

    it('should enforce reviewType enum', () => {
      const payload = {
        taskId: 'task-123',
        artifactPath: 'src/test.ts',
        artifactType: 'prd',
        reviewType: 'invalid-review',
        changedFiles: ['src/test.ts'],
        description: 'Test',
      };

      const result = validateWithSchema('review_request', payload);
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.includes('reviewType'))).toBe(true);
    });
  });

  describe('ReviewResult Validation', () => {
    it('should validate valid review result', () => {
      const payload = {
        taskId: 'task-123',
        verdict: 'pass',
        score: 8.5,
        dimensions: {
          correctness: 9,
          security: 8,
          performance: 8,
          maintainability: 9,
          test_coverage: 8,
        },
        feedback: 'Good implementation, minor performance suggestions',
        attempt: 1,
        maxAttempts: 3,
        requiresRework: false,
      };

      const result = validateWithSchema('review_result', payload);
      expect(result.valid).toBe(true);
    });

    it('should enforce verdict enum', () => {
      const payload = {
        taskId: 'task-123',
        verdict: 'maybe',
        score: 7,
        dimensions: {
          correctness: 7,
          security: 7,
          performance: 7,
          maintainability: 7,
          test_coverage: 7,
        },
        feedback: 'Test',
        attempt: 1,
        maxAttempts: 3,
        requiresRework: false,
      };

      const result = validateWithSchema('review_result', payload);
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.includes('verdict'))).toBe(true);
    });

    it('should validate nested dimensions object', () => {
      const payload = {
        taskId: 'task-123',
        verdict: 'pass',
        score: 8,
        dimensions: {
          correctness: 8,
          security: 8,
          // Missing: performance, maintainability, test_coverage
        },
        feedback: 'Test',
        attempt: 1,
        maxAttempts: 3,
        requiresRework: false,
      };

      const result = validateWithSchema('review_result', payload);
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.includes('dimensions.performance'))).toBe(true);
      expect(result.errors?.some(e => e.includes('dimensions.maintainability'))).toBe(true);
      expect(result.errors?.some(e => e.includes('dimensions.test_coverage'))).toBe(true);
    });

    it('should validate dimension score ranges', () => {
      const payload = {
        taskId: 'task-123',
        verdict: 'pass',
        score: 8,
        dimensions: {
          correctness: 15, // Invalid: max is 10
          security: 0,     // Invalid: min is 1
          performance: 5,
          maintainability: 5,
          test_coverage: 5,
        },
        feedback: 'Test',
        attempt: 1,
        maxAttempts: 3,
        requiresRework: false,
      };

      const result = validateWithSchema('review_result', payload);
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.includes('dimensions.correctness'))).toBe(true);
      expect(result.errors?.some(e => e.includes('dimensions.security'))).toBe(true);
    });

    it('should accept reworkGuidance when requiresRework is true', () => {
      const payload = {
        taskId: 'task-123',
        verdict: 'reject',
        score: 4,
        dimensions: {
          correctness: 4,
          security: 3,
          performance: 5,
          maintainability: 4,
          test_coverage: 4,
        },
        feedback: 'Needs significant improvements',
        attempt: 1,
        maxAttempts: 3,
        requiresRework: true,
        reworkGuidance: 'Fix security issues in authentication flow',
      };

      const result = validateWithSchema('review_result', payload);
      expect(result.valid).toBe(true);
    });
  });

  describe('Escalation Validation', () => {
    it('should validate valid escalation', () => {
      const payload = {
        taskId: 'task-123',
        severity: 'high',
        reason: 'Database schema conflict with existing production data',
        suggestedAction: 'Require migration script review before deployment',
        context: {
          affectedTables: ['users', 'sessions'],
          estimatedDowntime: '15 minutes',
        },
      };

      const result = validateWithSchema('escalation', payload);
      expect(result.valid).toBe(true);
    });

    it('should enforce severity enum', () => {
      const payload = {
        taskId: 'task-123',
        severity: 'urgent',
        reason: 'Test',
        context: {},
      };

      const result = validateWithSchema('escalation', payload);
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.includes('severity'))).toBe(true);
    });

    it('should accept empty context object', () => {
      const payload = {
        taskId: 'task-123',
        severity: 'low',
        reason: 'Minor documentation update needed',
        context: {},
      };

      const result = validateWithSchema('escalation', payload);
      expect(result.valid).toBe(true);
    });
  });

  describe('ArtifactHandoff Validation', () => {
    it('should validate valid artifact handoff', () => {
      const payload = {
        artifactId: 'artifact-123',
        artifactType: 'api-spec',
        filePath: 'docs/api/auth-spec.yaml',
        producedBy: 'be-dev',
        consumedBy: 'fe-dev',
        description: 'Authentication API specification for frontend integration',
      };

      const result = validateWithSchema('artifact_handoff', payload);
      expect(result.valid).toBe(true);
    });

    it('should enforce artifactType enum', () => {
      const payload = {
        artifactId: 'artifact-123',
        artifactType: 'unknown-artifact',
        filePath: 'test.txt',
        producedBy: 'pm',
        consumedBy: 'pl',
        description: 'Test',
      };

      const result = validateWithSchema('artifact_handoff', payload);
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.includes('artifactType'))).toBe(true);
    });

    it('should enforce role enums for producedBy and consumedBy', () => {
      const payload = {
        artifactId: 'artifact-123',
        artifactType: 'prd',
        filePath: 'test.txt',
        producedBy: 'invalid-role',
        consumedBy: 'another-invalid-role',
        description: 'Test',
      };

      const result = validateWithSchema('artifact_handoff', payload);
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.includes('producedBy'))).toBe(true);
      expect(result.errors?.some(e => e.includes('consumedBy'))).toBe(true);
    });
  });

  describe('GateResult Validation', () => {
    it('should validate valid gate result', () => {
      const payload = {
        gateType: 'code-review',
        verdict: 'pass',
        score: 8.5,
        taskId: 'task-123',
        feedback: 'Code meets quality standards',
      };

      const result = validateWithSchema('gate_result', payload);
      expect(result.valid).toBe(true);
    });

    it('should enforce verdict enum', () => {
      const payload = {
        gateType: 'qa-review',
        verdict: 'pending',
        score: 7,
        taskId: 'task-123',
        feedback: 'Test',
      };

      const result = validateWithSchema('gate_result', payload);
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.includes('verdict'))).toBe(true);
    });

    it('should validate score range', () => {
      const payload = {
        gateType: 'security-review',
        verdict: 'pass',
        score: 15, // Invalid: max is 10
        taskId: 'task-123',
        feedback: 'Test',
      };

      const result = validateWithSchema('gate_result', payload);
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.includes('score'))).toBe(true);
    });
  });

  describe('General Validation', () => {
    it('should reject non-object payloads', () => {
      const result = validateWithSchema('task_assignment', 'not an object');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Payload must be an object');
    });

    it('should reject null payloads', () => {
      const result = validateWithSchema('task_assignment', null);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Payload must be an object');
    });

    it('should reject payloads with wrong field types', () => {
      const payload = {
        taskId: 123, // Should be string
        subject: 'Test',
        description: 'Test',
        fileOwnership: 'not-an-array', // Should be array
        priority: 'high', // Should be number
      };

      const result = validateWithSchema('task_assignment', payload);
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.includes('taskId'))).toBe(true);
      expect(result.errors?.some(e => e.includes('fileOwnership'))).toBe(true);
      expect(result.errors?.some(e => e.includes('priority'))).toBe(true);
    });
  });
});
