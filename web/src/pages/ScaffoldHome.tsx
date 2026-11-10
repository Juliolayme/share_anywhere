// Phase 0 entry page. Phase 1 replaces it with the guest-first app shell (Welcome → Transfer home).
export function ScaffoldHome() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 p-6">
      <h1 className="text-3xl font-semibold">Share Anywhere</h1>
      <p className="text-text-muted">
        Web app scaffold. The guest-first app shell arrives in Phase 1; see <code>docs/phases/</code>.
      </p>
      {import.meta.env.DEV && (
        <a className="w-fit rounded-md text-primary underline" href="/brand">
          Open the brand and token preview
        </a>
      )}
    </main>
  );
}
