import { notFound } from 'next/navigation';
import { IntegrationDetail } from '@/components/IntegrationDetail';
import { Sidebar } from '@/components/Sidebar';
import { api } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function IntegrationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let integration: Awaited<ReturnType<typeof api.getIntegration>>;
  try {
    integration = await api.getIntegration(id);
  } catch {
    notFound();
  }

  let runs: Awaited<ReturnType<typeof api.listRuns>> = [];
  try {
    runs = await api.listRuns(id);
  } catch {
    runs = [];
  }

  return (
    <div className="flex h-screen w-full">
      <Sidebar activeId={id} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-6 py-10">
          <IntegrationDetail
            integration={integration}
            runs={runs}
          />
        </div>
      </main>
    </div>
  );
}
