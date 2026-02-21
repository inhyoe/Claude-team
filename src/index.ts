/**
 * Claude Team - Role-based development team simulation plugin
 *
 * A fork of OMC v4.2.11 that provides role-based agents (PM, PL, Dev, QA, Design)
 * collaborating through a Kanban workflow with DAG-based task orchestration.
 */

// Shared types and constants
export * from './shared/index.js';

// Core engines
export * from './core/index.js';

// Kanban pipeline
export * from './kanban/index.js';

// Persistence layer
export * from './persistence/index.js';

// Agent system
export * from './agents/index.js';

// Communication protocol
export * from './communication/index.js';

// Quality gates
export * from './quality/index.js';

// Hooks (lifecycle events, DAG-Kanban sync, quality gate hooks)
export * from './hooks/index.js';

// Team management
export * from './team/index.js';

// Features
export * from './features/delegation-routing/index.js';
export * from './features/task-decomposer/index.js';
export * from './features/state-manager/index.js';
