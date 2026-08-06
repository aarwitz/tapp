export type Platform = "ios" | "android" | "web";
export type Criticality = "low" | "medium" | "high" | "critical";

export interface ActorDefinition {
  session?: "default" | "isolated" | "shared";
  role?: string;
  credentials?: {
    email?: string;
    password?: string;
    [name: string]: string | undefined;
  };
  vars?: Record<string, string | number | boolean>;
}

export interface TaskContractStep<TActor extends string = string> {
  actor: TActor;
  task: string;
  with?: Record<string, unknown>;
  save?: Record<string, string>;
  reason?: string;
}

export interface ContractExpectation {
  screen?: string;
  exists?: string;
  absent?: string;
  text?: { of: string; contains: string };
  eventually?: { timeoutMs: number; pollMs?: number };
}

export interface ExpectContractStep<TActor extends string = string> {
  actor: TActor;
  expect: ContractExpectation;
  reason?: string;
}

export interface RequestStep {
  request: {
    method?: string;
    path: string;
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  };
}

export interface ReleaseContract<TActors extends Record<string, ActorDefinition> = Record<string, ActorDefinition>> {
  kind?: "release-contract";
  version?: 1;
  name: string;
  title: string;
  description?: string;
  businessValue: string;
  criticality: Criticality;
  platforms: Platform[];
  policy?: {
    always?: boolean;
    prRelevant?: boolean;
    nightly?: boolean;
    tags?: string[];
  };
  url?: string;
  app?: string;
  timeoutMs?: number;
  actors: TActors;
  variables?: Record<string, string | number | boolean>;
  setup?: RequestStep[];
  steps: Array<TaskContractStep<Extract<keyof TActors, string>> | ExpectContractStep<Extract<keyof TActors, string>>>;
  teardown?: RequestStep[];
  coverage?: {
    nodes?: string[];
    edges?: string[];
    capabilities?: string[];
    sourcePaths?: string[];
  };
}

export declare function defineContract<const TActors extends Record<string, ActorDefinition>>(
  contract: ReleaseContract<TActors>,
): ReleaseContract<TActors> & { kind: "release-contract"; version: 1 };
