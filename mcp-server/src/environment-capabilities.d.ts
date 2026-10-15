export interface EnvironmentConfiguration {
  url?: string;
  environment?: 'test' | 'production' | 'unknown';
  defaultActor?: string;
  actors?: Record<string, { role?: string; credentials: Record<'email' | 'password', { env: string }> }>;
  capabilities?: Record<string, { phase: 'prepare' | 'verify' | 'cleanup'; description?: string; origin?: string; path: string; method?: 'GET' | 'POST'; headers?: Record<string, { env: string }>; status?: number; expect?: Record<string, string | number | boolean> }>;
}
export function validateEnvironmentConfiguration(config: unknown): string[];
export function environmentReadiness(config?: EnvironmentConfiguration, bindings?: string[]): {
  actors: Array<{name:string;role:string;status:string;missingBindings:string[];authenticated:boolean}>;
  capabilities: Array<{name:string;phase:string;description:string;status:string;missingBindings:string[];verified:boolean}>;
  defaultActor: string | null; environment: string; isolation: string; message:string;
};
export function selectEnvironmentActor(config: EnvironmentConfiguration, requested?: string): ({name:string} & NonNullable<EnvironmentConfiguration['actors']>[string]) | null;

export function isCredentialBinding(name: string): boolean;
