/**
 * Task Decomposer unit tests
 *
 * Tests: decomposeTask function, phase identification,
 * role assignment, file ownership, DAG node creation.
 */
import { describe, it, expect } from 'vitest';
import {
  decomposeTask,
  formatDecomposition,
  type DecompositionInput,
} from '../../src/features/task-decomposer/index.js';
import type { ComplexityScore, RoleType } from '../../src/shared/types.js';

// ============================================================
// DECOMPOSE TASK
// ============================================================

describe('decomposeTask', () => {
  it('should decompose tiny task without planning phase', () => {
    const input: DecompositionInput = {
      taskDescription: 'Fix typo in readme',
      complexity: makeComplexity('tiny', 0.1),
      availableRoles: ['pl', 'fe-dev', 'qa-engineer'],
    };

    const result = decomposeTask(input);

    // Tiny tasks skip planning
    expect(result.tasks.length).toBeGreaterThan(0);
    const hasPlanning = result.tasks.some(t => t.nodeType === 'planning');
    expect(hasPlanning).toBe(false);
  });

  it('should decompose small task with planning phase', () => {
    const input: DecompositionInput = {
      taskDescription: 'Add validation to form',
      complexity: makeComplexity('small', 0.3),
      availableRoles: ['pl', 'fe-dev', 'qa-engineer'],
    };

    const result = decomposeTask(input);

    const hasPlanning = result.tasks.some(t => t.nodeType === 'planning');
    expect(hasPlanning).toBe(true);
  });

  it('should decompose medium task with design phase', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build user profile API',
      complexity: makeComplexity('medium', 0.5),
      availableRoles: ['pm', 'pl', 'be-dev', 'qa-engineer'],
    };

    const result = decomposeTask(input);

    const hasDesign = result.tasks.some(t => t.nodeType === 'design');
    expect(hasDesign).toBe(true);
  });

  it('should decompose large task with all phases', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build full-stack authentication system',
      complexity: makeComplexity('large', 0.8),
      availableRoles: ['pm', 'pl', 'fe-dev', 'be-dev', 'qa-engineer'],
    };

    const result = decomposeTask(input);

    const nodeTypes = new Set(result.tasks.map(t => t.nodeType));
    expect(nodeTypes.has('planning')).toBe(true);
    expect(nodeTypes.has('design')).toBe(true);
    expect(nodeTypes.has('execution')).toBe(true);
    expect(nodeTypes.has('verification')).toBe(true);
  });

  it('should always include execution and verification phases', () => {
    const input: DecompositionInput = {
      taskDescription: 'Simple task',
      complexity: makeComplexity('tiny', 0.1),
      availableRoles: ['pl', 'fe-dev', 'qa-engineer'],
    };

    const result = decomposeTask(input);

    const nodeTypes = result.tasks.map(t => t.nodeType);
    expect(nodeTypes).toContain('execution');
    expect(nodeTypes).toContain('verification');
  });

  it('should split into frontend and backend execution tracks', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build API backend and React frontend for user management',
      complexity: makeComplexity('medium', 0.5),
      availableRoles: ['pl', 'fe-dev', 'be-dev', 'qa-engineer'],
    };

    const result = decomposeTask(input);

    const execTasks = result.tasks.filter(t => t.nodeType === 'execution');
    expect(execTasks.length).toBe(2); // frontend and backend tracks
  });

  it('should use single execution track when no frontend/backend split needed', () => {
    const input: DecompositionInput = {
      taskDescription: 'Refactor database queries',
      complexity: makeComplexity('small', 0.3),
      availableRoles: ['pl', 'be-dev', 'qa-engineer'],
    };

    const result = decomposeTask(input);

    const execTasks = result.tasks.filter(t => t.nodeType === 'execution');
    expect(execTasks.length).toBe(1);
  });

  it('should add deployment phase for large tasks with deployment keywords', () => {
    const input: DecompositionInput = {
      taskDescription: 'Deploy microservice to production with Docker',
      complexity: makeComplexity('large', 0.8),
      availableRoles: ['pm', 'pl', 'be-dev', 'devops-engineer', 'qa-engineer'],
    };

    const result = decomposeTask(input);

    const hasDeployment = result.tasks.some(t => t.nodeType === 'deployment');
    expect(hasDeployment).toBe(true);
  });

  it('should assign roles based on node type preferences', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build feature',
      complexity: makeComplexity('medium', 0.5),
      availableRoles: ['pm', 'pl', 'fe-dev', 'qa-engineer'],
    };

    const result = decomposeTask(input);

    const planningTask = result.tasks.find(t => t.nodeType === 'planning');
    if (planningTask) {
      expect(['pm', 'pl']).toContain(planningTask.role);
    }

    const execTask = result.tasks.find(t => t.nodeType === 'execution');
    if (execTask) {
      expect(['fe-dev', 'be-dev', 'dba', 'devops-engineer']).toContain(execTask.role);
    }

    const verifyTask = result.tasks.find(t => t.nodeType === 'verification');
    if (verifyTask) {
      expect(['qa-engineer', 'security-specialist']).toContain(verifyTask.role);
    }
  });

  it('should fallback to first available role when no preferred role exists', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build feature',
      complexity: makeComplexity('small', 0.3),
      availableRoles: ['fe-dev'], // Only fe-dev available
    };

    const result = decomposeTask(input);

    // Should still create tasks, using fe-dev for all
    expect(result.tasks.length).toBeGreaterThan(0);
    for (const task of result.tasks) {
      expect(task.role).toBe('fe-dev');
    }
  });

  it('should assign file ownership based on node type', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build feature',
      complexity: makeComplexity('small', 0.3),
      availableRoles: ['pl', 'fe-dev', 'qa-engineer'],
      fileContext: [
        'src/app.ts',
        'src/components/Form.tsx',
        'tests/form.test.ts',
        'docker-compose.yml',
      ],
    };

    const result = decomposeTask(input);

    // Planning tasks should have no files
    const planningTask = result.tasks.find(t => t.nodeType === 'planning');
    if (planningTask) {
      expect(planningTask.fileOwnership).toEqual([]);
    }

    // Execution tasks should have code files
    const execTask = result.tasks.find(t => t.nodeType === 'execution');
    if (execTask) {
      expect(execTask.fileOwnership.length).toBeGreaterThan(0);
      expect(execTask.fileOwnership).toContain('src/app.ts');
    }

    // Verification tasks should have test files
    const verifyTask = result.tasks.find(t => t.nodeType === 'verification');
    if (verifyTask) {
      expect(verifyTask.fileOwnership).toContain('tests/form.test.ts');
    }
  });

  it('should handle empty file context', () => {
    const input: DecompositionInput = {
      taskDescription: 'Plan architecture',
      complexity: makeComplexity('small', 0.3),
      availableRoles: ['pl', 'fe-dev'],
      fileContext: [],
    };

    const result = decomposeTask(input);

    for (const task of result.tasks) {
      expect(task.fileOwnership).toEqual([]);
    }
  });

  it('should create task dependencies correctly', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build feature',
      complexity: makeComplexity('medium', 0.5),
      availableRoles: ['pm', 'pl', 'fe-dev', 'qa-engineer'],
    };

    const result = decomposeTask(input);

    // Planning should have no deps
    const planningIdx = result.tasks.findIndex(t => t.nodeType === 'planning');
    if (planningIdx >= 0) {
      expect(result.tasks[planningIdx].dependsOn).toEqual([]);
    }

    // Execution should depend on previous phases
    const execIdx = result.tasks.findIndex(t => t.nodeType === 'execution');
    if (execIdx > 0) {
      expect(result.tasks[execIdx].dependsOn.length).toBeGreaterThan(0);
    }

    // Verification should depend on execution
    const verifyIdx = result.tasks.findIndex(t => t.nodeType === 'verification');
    if (verifyIdx > execIdx) {
      expect(result.tasks[verifyIdx].dependsOn).toContain(execIdx);
    }
  });

  it('should generate TaskSpec array with correct IDs', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build feature',
      complexity: makeComplexity('small', 0.3),
      availableRoles: ['pl', 'fe-dev', 'qa-engineer'],
    };

    const result = decomposeTask(input);

    expect(result.taskSpecs.length).toBe(result.tasks.length);

    for (let i = 0; i < result.taskSpecs.length; i++) {
      const spec = result.taskSpecs[i];
      expect(spec.id).toBe(`task-${i}`);
      expect(spec.title).toBe(result.tasks[i].subject);
      expect(spec.assignedRole).toBe(result.tasks[i].role);
      expect(spec.nodeType).toBe(result.tasks[i].nodeType);
    }
  });

  it('should convert task dependencies to TaskSpec dependencies', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build feature',
      complexity: makeComplexity('medium', 0.5),
      availableRoles: ['pm', 'pl', 'fe-dev', 'qa-engineer'],
    };

    const result = decomposeTask(input);

    for (let i = 0; i < result.tasks.length; i++) {
      const task = result.tasks[i];
      const spec = result.taskSpecs[i];

      const expectedDeps = task.dependsOn.map(d => `task-${d}`);
      expect(spec.dependencies).toEqual(expectedDeps);
    }
  });

  it('should set priority based on task index', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build feature',
      complexity: makeComplexity('small', 0.3),
      availableRoles: ['pl', 'fe-dev', 'qa-engineer'],
    };

    const result = decomposeTask(input);

    for (let i = 0; i < result.taskSpecs.length; i++) {
      expect(result.taskSpecs[i].priority).toBe(i + 1);
    }
  });

  it('should count unique DAG layers', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build feature',
      complexity: makeComplexity('large', 0.8),
      availableRoles: ['pm', 'pl', 'fe-dev', 'qa-engineer'],
    };

    const result = decomposeTask(input);

    const uniqueNodeTypes = new Set(result.tasks.map(t => t.nodeType));
    expect(result.dagLayers).toBe(uniqueNodeTypes.size);
  });

  it('should include summary with task count and layers', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build feature',
      complexity: makeComplexity('medium', 0.5),
      availableRoles: ['pm', 'pl', 'fe-dev', 'qa-engineer'],
    };

    const result = decomposeTask(input);

    expect(result.summary).toContain(`${result.tasks.length} tasks`);
    expect(result.summary).toContain(`${result.dagLayers} phases`);
  });

  it('should set provider from role definition', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build feature',
      complexity: makeComplexity('small', 0.3),
      availableRoles: ['pl', 'fe-dev', 'qa-engineer'],
    };

    const result = decomposeTask(input);

    for (const task of result.tasks) {
      expect(['claude', 'codex', 'gemini']).toContain(task.provider);
    }
  });

  it('should estimate complexity for each subtask', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build feature',
      complexity: makeComplexity('medium', 0.5),
      availableRoles: ['pm', 'pl', 'fe-dev', 'qa-engineer'],
    };

    const result = decomposeTask(input);

    for (const task of result.tasks) {
      expect(task.estimatedComplexity).toBeGreaterThanOrEqual(0);
      expect(task.estimatedComplexity).toBeLessThanOrEqual(1);
    }
  });

  it('should handle missing availableRoles gracefully', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build feature',
      complexity: makeComplexity('small', 0.3),
      availableRoles: [],
    };

    const result = decomposeTask(input);

    // Should skip tasks that can't be assigned
    expect(result.tasks.length).toBe(0);
    expect(result.taskSpecs.length).toBe(0);
  });
});

// ============================================================
// FILE ASSIGNMENT PATTERNS
// ============================================================

describe('file assignment', () => {
  it('should assign code files to execution tasks', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build feature',
      complexity: makeComplexity('small', 0.3),
      availableRoles: ['pl', 'fe-dev', 'qa-engineer'],
      fileContext: ['src/app.ts', 'src/utils.js', 'README.md'],
    };

    const result = decomposeTask(input);
    const execTask = result.tasks.find(t => t.nodeType === 'execution');

    if (execTask) {
      expect(execTask.fileOwnership).toContain('src/app.ts');
      expect(execTask.fileOwnership).toContain('src/utils.js');
      expect(execTask.fileOwnership).not.toContain('README.md');
    }
  });

  it('should assign test files to verification tasks', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build feature',
      complexity: makeComplexity('small', 0.3),
      availableRoles: ['pl', 'fe-dev', 'qa-engineer'],
      fileContext: ['src/app.ts', 'tests/app.test.ts', 'src/app.spec.ts'],
    };

    const result = decomposeTask(input);
    const verifyTask = result.tasks.find(t => t.nodeType === 'verification');

    if (verifyTask) {
      expect(verifyTask.fileOwnership).toContain('tests/app.test.ts');
      expect(verifyTask.fileOwnership).toContain('src/app.spec.ts');
    }
  });

  it('should assign deployment files to deployment tasks', () => {
    const input: DecompositionInput = {
      taskDescription: 'Deploy to production with Docker',
      complexity: makeComplexity('large', 0.8),
      availableRoles: ['pm', 'pl', 'devops-engineer', 'qa-engineer'],
      fileContext: ['Dockerfile', 'docker-compose.yml', 'deploy/config.yaml', 'src/app.ts'],
    };

    const result = decomposeTask(input);
    const deployTask = result.tasks.find(t => t.nodeType === 'deployment');

    if (deployTask) {
      expect(deployTask.fileOwnership.some(f => f.includes('docker') || f.includes('deploy') || f.includes('.yaml'))).toBe(true);
      expect(deployTask.fileOwnership).not.toContain('src/app.ts');
    }
  });

  it('should support multiple programming language extensions', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build feature',
      complexity: makeComplexity('small', 0.3),
      availableRoles: ['pl', 'be-dev', 'qa-engineer'],
      fileContext: ['app.py', 'main.go', 'service.rs', 'App.java', 'script.sh'],
    };

    const result = decomposeTask(input);
    const execTask = result.tasks.find(t => t.nodeType === 'execution');

    if (execTask) {
      expect(execTask.fileOwnership).toContain('app.py');
      expect(execTask.fileOwnership).toContain('main.go');
      expect(execTask.fileOwnership).toContain('service.rs');
      expect(execTask.fileOwnership).toContain('App.java');
    }
  });
});

// ============================================================
// HEURISTIC DETECTION
// ============================================================

describe('task description heuristics', () => {
  it('should detect frontend keywords', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build React component with CSS styling',
      complexity: makeComplexity('medium', 0.5),
      availableRoles: ['pl', 'fe-dev', 'be-dev', 'qa-engineer'],
    };

    const result = decomposeTask(input);
    const execTasks = result.tasks.filter(t => t.nodeType === 'execution');

    // Frontend-only task doesn't split execution (only splits when BOTH frontend and backend detected)
    expect(execTasks.length).toBeGreaterThan(0);
    expect(execTasks.some(t => t.nodeType === 'execution')).toBe(true);
  });

  it('should detect backend keywords', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build REST API endpoint with database integration',
      complexity: makeComplexity('medium', 0.5),
      availableRoles: ['pl', 'fe-dev', 'be-dev', 'qa-engineer'],
    };

    const result = decomposeTask(input);
    const execTasks = result.tasks.filter(t => t.nodeType === 'execution');

    // Should create separate backend track
    expect(execTasks.length).toBe(2);
    expect(execTasks.some(t => t.subject.toLowerCase().includes('backend'))).toBe(true);
  });

  it('should detect deployment keywords', () => {
    const input: DecompositionInput = {
      taskDescription: 'Deploy service with Docker and Kubernetes',
      complexity: makeComplexity('large', 0.8),
      availableRoles: ['pm', 'pl', 'devops-engineer', 'qa-engineer'],
    };

    const result = decomposeTask(input);

    const hasDeployment = result.tasks.some(t => t.nodeType === 'deployment');
    expect(hasDeployment).toBe(true);
  });

  it('should not add deployment for non-deployment tasks', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build user form validation',
      complexity: makeComplexity('large', 0.8),
      availableRoles: ['pm', 'pl', 'fe-dev', 'qa-engineer'],
    };

    const result = decomposeTask(input);

    const hasDeployment = result.tasks.some(t => t.nodeType === 'deployment');
    expect(hasDeployment).toBe(false);
  });
});

// ============================================================
// FORMAT DECOMPOSITION
// ============================================================

describe('formatDecomposition', () => {
  it('should format decomposition as string', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build feature',
      complexity: makeComplexity('small', 0.3),
      availableRoles: ['pl', 'fe-dev', 'qa-engineer'],
    };

    const result = decomposeTask(input);
    const formatted = formatDecomposition(result);

    expect(formatted).toContain(result.summary);
    expect(formatted).toContain('planning');
    expect(formatted).toContain('execution');
    expect(formatted).toContain('verification');
  });

  it('should show task dependencies', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build feature',
      complexity: makeComplexity('medium', 0.5),
      availableRoles: ['pm', 'pl', 'fe-dev', 'qa-engineer'],
    };

    const result = decomposeTask(input);
    const formatted = formatDecomposition(result);

    // Should show "depends on: X"
    expect(formatted).toContain('depends on:');
  });

  it('should show assigned roles and providers', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build feature',
      complexity: makeComplexity('small', 0.3),
      availableRoles: ['pl', 'fe-dev', 'qa-engineer'],
    };

    const result = decomposeTask(input);
    const formatted = formatDecomposition(result);

    for (const task of result.tasks) {
      expect(formatted).toContain(task.role);
      expect(formatted).toContain(task.provider);
    }
  });

  it('should show file ownership when present', () => {
    const input: DecompositionInput = {
      taskDescription: 'Build feature',
      complexity: makeComplexity('small', 0.3),
      availableRoles: ['pl', 'fe-dev', 'qa-engineer'],
      fileContext: ['src/app.ts', 'tests/app.test.ts'],
    };

    const result = decomposeTask(input);
    const formatted = formatDecomposition(result);

    expect(formatted).toContain('Files:');
  });
});

// ============================================================
// HELPERS
// ============================================================

function makeComplexity(level: ComplexityScore['level'], score: number): ComplexityScore {
  return {
    level,
    score,
    factors: {
      fileCount: 10,
      crossModuleDeps: 3,
      hasTests: true,
      hasApiChanges: true,
      hasDbChanges: false,
      hasSecurityImplications: false,
    },
    recommendedAgentCount: level === 'tiny' ? 1 : level === 'small' ? 2 : level === 'medium' ? 3 : 4,
  };
}
