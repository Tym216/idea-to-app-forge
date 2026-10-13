import { config } from './config.js';
import { assertEnvironment, assertKeyProject, environmentProblems } from '../../shared/environment.js';
export const environmentConfig = (c = config) => ({ environmentId: c.environmentId, expectedRef: c.expectedSupabaseProjectRef, supabaseUrl: c.supabaseUrl, explicit: c.envFileExplicit });
export const assertWorkerEnvironment = (c = config) => { const identity=assertEnvironment(environmentConfig(c)); assertKeyProject(c.supabaseServiceRoleKey,c.expectedSupabaseProjectRef); return identity; };
export const workerEnvironmentProblems = (c = config) => environmentProblems(environmentConfig(c));
