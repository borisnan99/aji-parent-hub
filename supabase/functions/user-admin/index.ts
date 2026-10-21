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

    if (action === "contacts") {
      // admin phone directory: each active pupil with their guardians' tap-to-call numbers
      const { data: pupils } = await svc.from("pupils").select("id,first_name,last_name,academic_year").eq("is_active", true).order("last_name");
      const { data: links } = await svc.from("parent_pupil").select("pupil_id,parent_id,is_primary");
      const parentIds = [...new Set((links ?? []).map((l: any) => l.parent_id))];
      const { data: gc } = await svc.from("guardian_contacts").select("id,parent_id,label,name,mobile");
      const { data: profs } = parentIds.length ? await svc.from("profiles").select("id,full_name").in("id", parentIds) : { data: [] };
      const pname: Record<string, string> = {}; (profs ?? []).forEach((p: any) => (pname[p.id] = p.full_name || ""));
      const byParent: Record<string, any[]> = {};
      (gc ?? []).forEach((g: any) => { const mob = (g.mobile || "").trim(); if (mob) (byParent[g.parent_id] = byParent[g.parent_id] || []).push({ id: g.id, label: g.label || "", name: g.name || "", mobile: mob }); });
      const byPupil: Record<string, { pids: Set<string>; primary: Set<string> }> = {};
      (links ?? []).forEach((l: any) => { const e = (byPupil[l.pupil_id] = byPupil[l.pupil_id] || { pids: new Set(), primary: new Set() }); e.pids.add(l.parent_id); if (l.is_primary) e.primary.add(l.parent_id); });
      const out = (pupils ?? []).map((pu: any) => {
        const e = byPupil[pu.id] || { pids: new Set(), primary: new Set() };
        const seen = new Set<string>(); const contacts: any[] = [];
        [...e.pids].forEach((pid) => (byParent[pid] || []).forEach((c) => { const key = c.mobile.replace(/\s+/g, ""); if (seen.has(key)) return; seen.add(key); contacts.push({ ...c, parent_id: pid, parent_name: pname[pid] || "", primary: e.primary.has(pid) }); }));
        contacts.sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
        const parents = [...e.pids].map((pid) => ({ id: pid, name: pname[pid] || "", primary: e.primary.has(pid) })).sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
        return { pupil_id: pu.id, name: `${pu.first_name} ${pu.last_name}`, year: pu.academic_year || "", contacts, parents };
      });
      return json({ ok: true, pupils: out });
    }

    if (action === "contact_save") {
      const mob = (body.mobile || "").trim();
      if (!mob) return json({ error: "a mobile number is required" }, 400);
      const fields = { label: (body.label || "").trim() || null, name: (body.name || "").trim() || null, mobile: mob };
      if (body.id) {
        const { error } = await svc.from("guardian_contacts").update(fields).eq("id", body.id);
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true, id: body.id });
      }
      if (!body.parent_id) return json({ error: "no parent linked to attach this number to" }, 400);
      const { data, error } = await svc.from("guardian_contacts").insert({ parent_id: body.parent_id, ...fields }).select("id").single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, id: data.id });
    }

    if (action === "contact_delete") {
      if (!body.id) return json({ error: "id required" }, 400);
      const { error } = await svc.from("guardian_contacts").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "pupil_card") {
      // one pupil's guardians, each with their email and their phone numbers — for the pupil editor
      const pid = body.pupil_id;
      if (!pid) return json({ error: "pupil_id required" }, 400);
      const { data: links } = await svc.from("parent_pupil").select("parent_id,is_primary").eq("pupil_id", pid);
      const parentIds = [...new Set((links ?? []).map((l: any) => l.parent_id))];
      const { data: profs } = parentIds.length ? await svc.from("profiles").select("id,full_name,email").in("id", parentIds) : { data: [] };
      const pmap: Record<string, any> = {}; (profs ?? []).forEach((p: any) => (pmap[p.id] = p));
      const { data: gc } = parentIds.length ? await svc.from("guardian_contacts").select("id,parent_id,label,name,mobile").in("parent_id", parentIds) : { data: [] };
      const byParent: Record<string, any[]> = {};
      (gc ?? []).forEach((g: any) => { (byParent[g.parent_id] = byParent[g.parent_id] || []).push({ id: g.id, label: g.label || "", name: g.name || "", mobile: g.mobile || "" }); });
      const guardians = (links ?? []).filter((l: any) => pmap[l.parent_id]).map((l: any) => ({
        parent_id: l.parent_id, full_name: pmap[l.parent_id].full_name || "", email: pmap[l.parent_id].email || "",
        is_primary: !!l.is_primary, numbers: byParent[l.parent_id] || [],
      })).sort((a: any, b: any) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0));
      return json({ ok: true, guardians });
    }

    if (action === "set_preferred") {
      // mark one linked parent as the preferred (primary) contact for this pupil
      const pid = body.pupil_id, parent = body.parent_id;
      if (!pid || !parent) return json({ error: "pupil_id and parent_id required" }, 400);
      await svc.from("parent_pupil").update({ is_primary: false }).eq("pupil_id", pid);
      const { error } = await svc.from("parent_pupil").update({ is_primary: true }).eq("pupil_id", pid).eq("parent_id", parent);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "parent_email") {
      // change a parent's email — used for exam marks & announcements. Keep the login in sync if they have one.
      const parent = body.parent_id; const email = (body.email || "").trim();
      if (!parent) return json({ error: "parent_id required" }, 400);
      if (!email || !email.includes("@")) return json({ error: "enter a valid email address" }, 400);
      const { error } = await svc.from("profiles").update({ email }).eq("id", parent);
      if (error) return json({ error: error.message }, 500);
      try { await svc.auth.admin.updateUserById(parent, { email, email_confirm: true }); } catch { /* parent may have no login; profiles.email is what we email */ }
      return json({ ok: true, email });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
