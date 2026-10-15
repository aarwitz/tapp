export interface BusinessStep {
  id: string; title: string; outcome: string; kind: 'flow'|'capability'|'contract'|'manual';
  ref?: string; actor?: string; targetId?: string;
}
export interface BusinessWorkflow {
  id: string; title: string; outcome: string; priority: 'critical'|'high'|'normal';
  decision: 'proposed'|'confirmed'|'deferred'; steps: BusinessStep[];
}
export interface BusinessWorkflows {
  kind: 'tapp-business-workflows'; schemaVersion: 1; revision: number; description: string; workflows: BusinessWorkflow[];
}
export interface WorkflowProject {
  targets?: Array<{id:string;name?:string;platform:string}>;
  flows?: Array<{path:string;name?:string;platform?:string;sha256?:string}>;
  actors?: Array<{name:string;status?:string}>;
  map?: {nodes?:Array<{id:string;name?:string;stateLabel?:string}>}|null;
  model?: {artifacts?:{contracts?:Array<{path:string;name:string}>};criticalJourneys?:Array<{contract:string;businessValue?:string}>}|null;
}
export interface WorkflowConnection {
  environment?:string; configuration?:unknown; accessRevision?:string;
  actors?:Array<{name:string;status?:string}>;
  capabilities?:Array<{name:string;phase:string;status:string}>;
}
export interface WorkflowRun {
  operationId?:string; workflowId:string; revision:number; bindingFingerprint:string;
  status:string; steps?:Array<{id:string;status:string}>; completedAt?:string;
}
export interface WorkflowPlan {
  kind: 'tapp-business-workflow-plan'; workflowId:string; revision:number; title:string; outcome:string;
  bindingFingerprint:string; ready:boolean;
  steps:Array<BusinessStep & {phase:string;sha256?:string;platform?:string;missing:string[]}>;
  blockers:Array<{code:string;stepId?:string;message:string}>;
  correlationVariable:string; requiresCorrelation:boolean; scope:string;
}
export const BUSINESS_WORKFLOW_PATH: string;
export function workflowFingerprint(value:unknown):string;
export function emptyBusinessWorkflows():BusinessWorkflows;
export function validateBusinessWorkflows(document:unknown):string[];
export function normalizeBusinessWorkflows(document:unknown):BusinessWorkflows;
export function discoverBusinessWorkflows(project?:WorkflowProject,connection?:WorkflowConnection):{
  targets:NonNullable<WorkflowProject['targets']>; actors:NonNullable<WorkflowConnection['actors']>;
  flows:NonNullable<WorkflowProject['flows']>; contracts:Array<{path:string;name:string}>;
  capabilities:NonNullable<WorkflowConnection['capabilities']>;
  surfaces:Array<{id:string;name:string;basis:string}>; proposals:BusinessWorkflow[]; questions:string[]; scope:string;
};
export function planBusinessWorkflow(document:BusinessWorkflows,workflowId:string,project?:WorkflowProject,connection?:WorkflowConnection):WorkflowPlan;
export function businessWorkflowCoverage(document:BusinessWorkflows,project?:WorkflowProject,connection?:WorkflowConnection,runs?:WorkflowRun[]):{
  kind:string; revision:number; counts:Record<string,number>; scope:string;
  workflows:Array<{id:string;title:string;priority:string;status:string;blockers:WorkflowPlan['blockers'];steps:Array<{id:string;title:string;outcome:string;status:string}>;lastRun?:WorkflowRun}>;
};
