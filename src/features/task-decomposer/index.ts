/**
 * Claude Team - DAG-Aware Task Decomposer
 *
 * Decomposes high-level tasks into DAG nodes with role assignments
 * and file ownership. Extends OMC's task decomposer with role awareness.
 */

import type {
  RoleType,
  DAGNodeType,
  ComplexityScore,
} from '../../shared/types.js';
import type { TaskSpec } from '../../core/dag-types.js';
import { ROLE_DEFINITIONS } from '../../shared/constants.js';

// ============================================================
// DECOMPOSITION TYPES
// ============================================================

export interface DecompositionInput {
  taskDescription: string;
  complexity: ComplexityScore;
  availableRoles: RoleType[];
  fileContext?: string[];      // files involved
  codebaseContext?: string;    // codebase analysis
}

export interface DecomposedTask {
  subject: string;
  description: string;
  role: RoleType;
  nodeType: DAGNodeType;
  fileOwnership: string[];
  dependsOn: number[];       // indices of other decomposed tasks
  estimatedComplexity: number; // 0-1
  provider: 'claude' | 'codex' | 'gemini';
}

export interface DecompositionResult {
  tasks: DecomposedTask[];
  taskSpecs: TaskSpec[];
  dagLayers: number;
  summary: string;
}

// ============================================================
// TASK DECOMPOSITION
// ============================================================

/**
 * Decompose a task description into role-assigned subtasks.
 * This creates the task structure; actual DAG building is done by dag-engine.
 */
export function decomposeTask(input: DecompositionInput): DecompositionResult {
  const { taskDescription, complexity, availableRoles, fileContext } = input;

  // Analyze task to determine required phases
  const phases = identifyPhases(taskDescription, complexity);

  // Create subtasks per phase
  const tasks: DecomposedTask[] = [];
  let taskIndex = 0;

  for (const phase of phases) {
    const role = selectRole(phase.nodeType, availableRoles);
    if (!role) continue;

    const roleDef = ROLE_DEFINITIONS[role];
    const files = assignFiles(phase.nodeType, fileContext ?? []);

    tasks.push({
      subject: phase.subject,
      description: phase.description,
      role,
      nodeType: phase.nodeType,
      fileOwnership: files,
      dependsOn: phase.dependsOn.map(d => d), // indices
      estimatedComplexity: phase.complexity,
      provider: roleDef?.provider ?? 'claude',
    });

    taskIndex++;
  }

  // Convert to TaskSpecs for DAG engine
  const taskSpecs: TaskSpec[] = tasks.map((t, i) => ({
    id: `task-${i}`,
    title: t.subject,
    description: t.description,
    assignedRole: t.role,
    nodeType: t.nodeType,
    filePatterns: t.fileOwnership,
    dependencies: t.dependsOn.map(d => `task-${d}`),
    priority: i + 1,
  }));

  // Count unique layers
  const layerTypes = new Set(tasks.map(t => t.nodeType));

  return {
    tasks,
    taskSpecs,
    dagLayers: layerTypes.size,
    summary: `Decomposed into ${tasks.length} tasks across ${layerTypes.size} phases`,
  };
}

// ============================================================
// PHASE IDENTIFICATION
// ============================================================

interface Phase {
  subject: string;
  description: string;
  nodeType: DAGNodeType;
  complexity: number;
  dependsOn: number[];
}

/**
 * Identify the phases needed based on task description and complexity.
 */
function identifyPhases(description: string, complexity: ComplexityScore): Phase[] {
  const phases: Phase[] = [];
  const desc = description.toLowerCase();

  // Always start with planning for medium+ tasks
  if (complexity.level !== 'tiny') {
    phases.push({
      subject: 'Plan and design approach',
      description: `Analyze requirements and design approach for: ${description}`,
      nodeType: 'planning',
      complexity: 0.3,
      dependsOn: [],
    });
  }

  // Design phase for complex tasks
  if (complexity.level === 'large' || complexity.level === 'medium') {
    phases.push({
      subject: 'Design architecture and API',
      description: `Design technical architecture for: ${description}`,
      nodeType: 'design',
      complexity: 0.4,
      dependsOn: phases.length > 0 ? [0] : [],
    });
  }

  // Execution phase - always present
  const execDeps = phases.length > 0 ? [phases.length - 1] : [];

  if (hasMultipleExecutionTracks(desc)) {
    // Split into frontend and backend tracks
    const execIndex = phases.length;
    phases.push({
      subject: 'Implement backend changes',
      description: `Backend implementation for: ${description}`,
      nodeType: 'execution',
      complexity: 0.6,
      dependsOn: execDeps,
    });
    phases.push({
      subject: 'Implement frontend changes',
      description: `Frontend implementation for: ${description}`,
      nodeType: 'execution',
      complexity: 0.5,
      dependsOn: execDeps,
    });

    // Verification depends on both execution tracks
    phases.push({
      subject: 'Verify and test changes',
      description: `Test and verify all changes for: ${description}`,
      nodeType: 'verification',
      complexity: 0.4,
      dependsOn: [execIndex, execIndex + 1],
    });
  } else {
    // Single execution track
    phases.push({
      subject: 'Implement changes',
      description: `Implementation for: ${description}`,
      nodeType: 'execution',
      complexity: 0.5,
      dependsOn: execDeps,
    });

    // Verification
    phases.push({
      subject: 'Verify and test changes',
      description: `Test and verify changes for: ${description}`,
      nodeType: 'verification',
      complexity: 0.3,
      dependsOn: [phases.length - 1],
    });
  }

  // Deployment phase for large tasks
  if (complexity.level === 'large' && needsDeployment(desc)) {
    phases.push({
      subject: 'Configure deployment',
      description: `Deployment configuration for: ${description}`,
      nodeType: 'deployment',
      complexity: 0.3,
      dependsOn: [phases.length - 1],
    });
  }

  return phases;
}

// ============================================================
// ROLE SELECTION
// ============================================================

/**
 * Select the best role for a given phase type.
 */
function selectRole(nodeType: DAGNodeType, availableRoles: RoleType[]): RoleType | null {
  const preference: Record<DAGNodeType, RoleType[]> = {
    'planning': ['pm', 'pl'],
    'design': ['pl', 'ui-ux-designer'],
    'execution': ['be-dev', 'fe-dev', 'dba', 'devops-engineer'],
    'verification': ['qa-engineer', 'security-specialist'],
    'deployment': ['devops-engineer', 'be-dev'],
  };

  const prefs = preference[nodeType] ?? [];
  for (const role of prefs) {
    if (availableRoles.includes(role)) return role;
  }

  // Fallback to first available
  return availableRoles[0] ?? null;
}

// ============================================================
// FILE ASSIGNMENT
// ============================================================

/**
 * Assign files to phases based on node type.
 */
function assignFiles(nodeType: DAGNodeType, files: string[]): string[] {
  if (files.length === 0) return [];

  switch (nodeType) {
    case 'planning':
    case 'design':
      return []; // Planners don't own code files

    case 'execution':
      return files.filter(f =>
        f.endsWith('.ts') || f.endsWith('.tsx') ||
        f.endsWith('.js') || f.endsWith('.jsx') ||
        f.endsWith('.py') || f.endsWith('.go') ||
        f.endsWith('.rs') || f.endsWith('.java')
      );

    case 'verification':
      return files.filter(f =>
        f.includes('test') || f.includes('spec') || f.includes('.test.')
      );

    case 'deployment':
      return files.filter(f =>
        f.includes('docker') || f.includes('deploy') ||
        f.includes('ci') || f.includes('.yaml') || f.includes('.yml')
      );

    default:
      return [];
  }
}

// ============================================================
// HEURISTICS
// ============================================================

function hasMultipleExecutionTracks(desc: string): boolean {
  const frontendKeywords = ['frontend', 'ui', 'component', 'react', 'vue', 'css'];
  const backendKeywords = ['backend', 'api', 'server', 'database', 'endpoint'];

  const hasFrontend = frontendKeywords.some(k => desc.includes(k));
  const hasBackend = backendKeywords.some(k => desc.includes(k));

  return hasFrontend && hasBackend;
}

function needsDeployment(desc: string): boolean {
  const deployKeywords = ['deploy', 'production', 'release', 'ci/cd', 'docker', 'kubernetes'];
  return deployKeywords.some(k => desc.includes(k));
}

/**
 * Format decomposition result for display.
 */
export function formatDecomposition(result: DecompositionResult): string {
  const lines: string[] = [result.summary, ''];

  for (let i = 0; i < result.tasks.length; i++) {
    const t = result.tasks[i];
    const deps = t.dependsOn.length > 0 ? ` (depends on: ${t.dependsOn.join(', ')})` : '';
    lines.push(`  ${i}. [${t.nodeType}] ${t.subject} -> ${t.role} (${t.provider})${deps}`);
    if (t.fileOwnership.length > 0) {
      lines.push(`     Files: ${t.fileOwnership.join(', ')}`);
    }
  }

  return lines.join('\n');
}
