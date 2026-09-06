export function GET() {
  return Response.json({ ok: true, service: "corridor-web", at: new Date().toISOString() });
}
