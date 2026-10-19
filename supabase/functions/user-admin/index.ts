// user-admin — admin-only. Manage who can access the Hub.
//  • list    — staff & admin accounts with last sign-in and access status
//  • search  — find any user (incl. parents) by name or email
//  • set_active — revoke or restore a user's access (sets profiles.is_active AND bans/unbans the
//    auth login). We never hard-delete: profiles are referenced by behaviour logs, boarding checks,
//    safeguarding records, the audit log, messages, etc., so removing a row would break that history.
//    Deactivating keeps everything they logged attributed to them, and can be reversed any time.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const BAN = "876000h"; // ~100 years — effectively blocks sign-in until restored

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "parent_hub" } });
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { db: { schema: "parent_hub" }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);
    const { data: me } = await svc.from("profiles").select("role").eq("id", user.id).single();
    if (!me || me.role !== "admin") return json({ error: "admins only" }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action || "list";

    // id -> { last_sign_in_at, banned } from the auth system
    async function authMap(): Promise<Record<string, { last: string | null; banned: boolean }>> {
      const m: Record<string, { last: string | null; banned: boolean }> = {};
      for (let page = 1; page <= 20; page++) {
        const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 200 });
        if (error) break;
        const users = data?.users ?? [];
        for (const u of users) { const bu = (u as any).banned_until; m[u.id] = { last: u.last_sign_in_at ?? null, banned: !!(bu && new Date(bu) > new Date()) }; }
        if (users.length < 200) break;
      }
      return m;
    }
    const fmtRow = (p: any, a?: { last: string | null; banned: boolean }) => ({ id: p.id, full_name: p.full_name, email: p.email, role: p.role, is_active: p.is_active !== false, last_sign_in: a?.last ?? null, banned: !!a?.banned });

    if (action === "list") {
      const { data: profs } = await svc.from("profiles").select("id,full_name,email,role,is_active").in("role", ["admin", "staff"]).order("full_name");
      const am = await authMap();
      return json({ ok: true, me: user.id, users: (profs ?? []).map((p: any) => fmtRow(p, am[p.id])) });
    }

    if (action === "search") {
      const q = (body.q || "").trim();
      if (q.length < 2) return json({ ok: true, users: [] });
      const like = `%${q}%`;
      const { data: profs } = await svc.from("profiles").select("id,full_name,email,role,is_active").or(`full_name.ilike.${like},email.ilike.${like}`).order("full_name").limit(25);
      const rows: any[] = [];
      for (const p of profs ?? []) {
        let a: { last: string | null; banned: boolean } | undefined;
        try { const { data } = await svc.auth.admin.getUserById(p.id); const bu = (data?.user as any)?.banned_until; a = { last: data?.user?.last_sign_in_at ?? null, banned: !!(bu && new Date(bu) > new Date()) }; } catch { /* ignore */ }
        rows.push(fmtRow(p, a));
      }
      return json({ ok: true, me: user.id, users: rows });
    }

    if (action === "set_active") {
      const target = body.user_id;
      const active = body.active === true;
      if (!target) return json({ error: "user_id required" }, 400);
      if (target === user.id) return json({ error: "You can't change your own access." }, 400);
      const { data: tgt } = await svc.from("profiles").select("id,role,full_name,is_active").eq("id", target).maybeSingle();
      if (!tgt) return json({ error: "user not found" }, 404);
      // don't allow removing the last active admin
      if (!active && tgt.role === "admin") {
        const { count } = await svc.from("profiles").select("id", { count: "exact", head: true }).eq("role", "admin").eq("is_active", true);
        if ((count ?? 0) <= 1) return json({ error: "That's the last active admin — add another admin before removing this one." }, 400);
      }
      const { error: pe } = await svc.from("profiles").update({ is_active: active }).eq("id", target);
      if (pe) return json({ error: pe.message }, 500);
      try { await svc.auth.admin.updateUserById(target, { ban_duration: active ? "none" : BAN }); } catch (e: any) { return json({ error: "Access flag updated but sign-in block failed: " + String(e?.message ?? e) }, 500); }
      // A banned user can't get a new session; the app's is_active gate also signs them out on next load.
      return json({ ok: true, full_name: tgt.full_name, active });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
