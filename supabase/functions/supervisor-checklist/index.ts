// supervisor-checklist — daily boarding supervisor checklist (day/night). Saved per submission.
// Access: admins + Gulfam Khan + Zubair Patel. Actions: list, save, export.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const SUP_NAMES = ["gulfam khan", "zubair patel"];
const SUP_EMAILS = ["gulfam.khan@boltondarululoom.org.uk", "zubair.patel@boltondarululoom.org.uk"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "parent_hub" } });
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { db: { schema: "parent_hub" }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);
    const { data: me } = await svc.from("profiles").select("role,email,full_name").eq("id", user.id).single();
    const em = (me?.email || "").toLowerCase(), nm = (me?.full_name || "").trim().toLowerCase();
    const allowed = !!me && (me.role === "admin" || SUP_NAMES.includes(nm) || SUP_EMAILS.includes(em));
    if (!allowed) return json({ error: "not permitted" }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action || "list";

    async function withNames(rows: any[]) {
      const ids = [...new Set(rows.map((r) => r.logged_by).filter(Boolean))];
      const nmap: Record<string, string> = {};
      if (ids.length) { const { data } = await svc.from("profiles").select("id,full_name").in("id", ids); (data ?? []).forEach((u: any) => (nmap[u.id] = u.full_name)); }
      return rows.map((r) => ({ ...r, logged_by_name: nmap[r.logged_by] || r.supervisor_name || "—" }));
    }

    if (action === "list") {
      const { data } = await svc.from("supervisor_checklists").select("*").order("created_at", { ascending: false }).limit(60);
      return json({ ok: true, rows: await withNames(data ?? []) });
    }

    if (action === "save") {
      const row = {
        check_date: (body.check_date || new Date().toISOString().slice(0, 10)).slice(0, 10),
        supervisor_name: (body.supervisor_name || me.full_name || "").trim() || null,
        shift: body.shift || null,
        arrived_at: body.arrived_at || null,
        lights_out: body.lights_out || null,
        room_checks: Array.isArray(body.room_checks) ? body.room_checks : [],
        final_secured: body.final_secured === true,
        time_secured: body.time_secured || null,
        welfare_incidents: (body.welfare_incidents || "").trim() || null,
        maintenance_notes: (body.maintenance_notes || "").trim() || null,
        important_info: (body.important_info || "").trim() || null,
        logged_by: user.id,
      };
      if (!row.shift) return json({ error: "please choose day or night" }, 400);
      const { data, error } = await svc.from("supervisor_checklists").insert(row).select().single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, id: data.id });
    }

    if (action === "export") {
      const month = (body.month || new Date().toISOString().slice(0, 7)).slice(0, 7);
      const from = month + "-01";
      const d = new Date(from + "T00:00:00Z"); const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      const { data } = await svc.from("supervisor_checklists").select("*").gte("check_date", from).lte("check_date", to).order("check_date");
      return json({ ok: true, month, rows: await withNames(data ?? []) });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
