import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[50vh] max-w-xl flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-fg-secondary">The page you requested does not exist.</p>
      <Link className="btn-primary" href="/dashboard">
        Back to dashboard
      </Link>
    </main>
  );
}
