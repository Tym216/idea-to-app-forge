export const MAIN_REF: string;
export const RESTORE_REF: string;
export function projectRef(url?: string): string | null;
export type EnvironmentConfig = {environmentId?: string; expectedRef?: string; supabaseUrl?: string; explicit?: boolean};
export function environmentProblems(values: EnvironmentConfig): string[];
export function assertEnvironment(values: EnvironmentConfig): {environmentId: string; projectRef: string};
export function assertKeyProject(key?:string, expectedRef?:string):void;
