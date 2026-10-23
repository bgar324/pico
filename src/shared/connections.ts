import { record } from './validation';

export interface ConnectionAccount {
  credentialId: number;
  label: string;
  type: 'api_key' | 'oauth';
}
export interface ProviderConnection {
  id: string;
  name: string;
  authenticated: boolean;
  accounts: ConnectionAccount[];
  loginMethods: { id: string; label: string }[];
  apiKey: boolean;
}
export interface ConnectionPrompt { id: string; title: string; placeholder: string }
export type ConnectionAuth =
  | { kind: 'idle' }
  | { kind: 'pending'; id: string; providerId: string; message: string; url: string | null; prompt: ConnectionPrompt | null }
  | { kind: 'complete' | 'failed'; id: string; providerId: string; message: string };
export interface ConnectionsSnapshot { revision: number; providers: ProviderConnection[]; auth: ConnectionAuth }

export function isConnectionsSnapshot(value: unknown): value is ConnectionsSnapshot {
  if (!record(value) || !Number.isSafeInteger(value.revision) || !Array.isArray(value.providers) || !record(value.auth)) return false;
  if (!value.providers.every(provider => record(provider) && typeof provider.id === 'string' && typeof provider.name === 'string' &&
    typeof provider.authenticated === 'boolean' && typeof provider.apiKey === 'boolean' && Array.isArray(provider.accounts) &&
    provider.accounts.every(account => record(account) && Number.isSafeInteger(account.credentialId) && typeof account.label === 'string' && (account.type === 'api_key' || account.type === 'oauth')) &&
    Array.isArray(provider.loginMethods) && provider.loginMethods.every(method => record(method) && typeof method.id === 'string' && typeof method.label === 'string'))) return false;
  const auth = value.auth;
  if (auth.kind === 'idle') return true;
  if (typeof auth.id !== 'string' || typeof auth.providerId !== 'string' || typeof auth.message !== 'string') return false;
  if (auth.kind === 'complete' || auth.kind === 'failed') return true;
  return auth.kind === 'pending' && (auth.url === null || typeof auth.url === 'string') && (auth.prompt === null ||
    record(auth.prompt) && typeof auth.prompt.id === 'string' && typeof auth.prompt.title === 'string' && typeof auth.prompt.placeholder === 'string');
}
