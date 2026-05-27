import { Sidebar } from '@/components/Sidebar';
import { SubmitForm } from '@/components/SubmitForm';

export default function HomePage() {
  return (
    <div className="flex h-screen w-full">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full max-w-3xl flex-col px-6 py-12">
          <div className="flex flex-1 flex-col justify-center pb-10">
            <h1 className="text-center text-3xl font-semibold tracking-tight text-text md:text-4xl">
              What do you want to integrate?
            </h1>
            <p className="mt-3 text-center text-sm text-text-secondary">
              Describe the workflow in plain English. Temper drafts
              the code, runs it in a sandbox, and waits for your
              approval before deploying.
            </p>
          </div>

          <div className="pb-6">
            <SubmitForm />
            <p className="mt-3 text-center text-[11px] text-text-muted">
              Press{' '}
              <kbd className="rounded border border-bg-border bg-bg-surface px-1 py-0.5 font-mono text-[10px]">
                Enter
              </kbd>{' '}
              to submit ·{' '}
              <kbd className="rounded border border-bg-border bg-bg-surface px-1 py-0.5 font-mono text-[10px]">
                Shift
              </kbd>{' '}
              +{' '}
              <kbd className="rounded border border-bg-border bg-bg-surface px-1 py-0.5 font-mono text-[10px]">
                Enter
              </kbd>{' '}
              for newline.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
