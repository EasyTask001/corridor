"use client";

export default function Error({ reset }: { reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-[50vh] max-w-xl flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-fg-secondary">This page could not be loaded.</p>
      <button type="button" className="btn-primary" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
