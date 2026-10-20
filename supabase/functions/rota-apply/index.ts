// rota-apply — DISABLED. This was a one-off maintenance endpoint used once to apply the F2/F15/F16
// cleaning rotas from the uploaded sheets; it is now permanently turned off.
Deno.serve(() => new Response(JSON.stringify({ error: "gone" }), { status: 410, headers: { "content-type": "application/json" } }));
