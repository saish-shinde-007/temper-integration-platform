import type {
  Integration,
  Run,
  CreateIntegrationRequest,
} from './types';

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const TENANT_ID =
  process.env.NEXT_PUBLIC_TENANT_ID ?? 'tenant-demo';

export const API_BASE_URL = API_URL;
export const TENANT = TENANT_ID;

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const resp = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': TENANT_ID,
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (!resp.ok) {
    throw new Error(`${resp.status} ${await resp.text()}`);
  }
  return resp.json() as Promise<T>;
}

export const api = {
  listIntegrations: () =>
    call<Integration[]>('GET', '/v1/integrations'),
  getIntegration: (id: string) =>
    call<Integration>('GET', `/v1/integrations/${id}`),
  createIntegration: (data: CreateIntegrationRequest) =>
    call<Integration>('POST', '/v1/integrations', data),
  test: (id: string) =>
    call<{ ok: true; workflow_id?: string }>(
      'POST',
      `/v1/integrations/${id}/test`,
      {},
    ),
  approve: (id: string, versionId: string) =>
    call<{ ok: true }>('POST', `/v1/integrations/${id}/approve`, {
      version_id: versionId,
    }),
  reject: (id: string, reason?: string) =>
    call<{ ok: true }>('POST', `/v1/integrations/${id}/reject`, {
      reason: reason ?? '',
    }),
  deploy: (id: string) =>
    call<{ ok: true }>('POST', `/v1/integrations/${id}/deploy`, {}),
  listRuns: (id: string) =>
    call<Run[]>('GET', `/v1/integrations/${id}/runs`),
};
