// boarding-check — daily boarding room checks (beds, cupboards, carpets, lights, switches, radiators, windows, window restrictors).
// A missing/faulty window restrictor is flagged immediately to Maulana Gulfam (email + push) to action that day.
// Access: admins + Ihsaanul Haque (checker) + Gulfam Khan. Resolve/manage: admins (incl. Gulfam).
// Actions: load, save, resolve, export, add_room, set_room_active.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });

const CHECK_NAMES = ["ihsaanul haque", "gulfam khan"];
const CHECK_EMAILS = ["ihsaanul.haque@boltondarululoom.org.uk", "gulfam.khan@boltondarululoom.org.uk"];
const GULFAM_EMAIL = "gulfam.khan@boltondarululoom.org.uk";
const bool = (v: unknown) => v === true;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "parent_hub" } });
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { db: { schema: "parent_hub" }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);
    const { data: me } = await svc.from("profiles").select("role,email,full_name").eq("id", user.id).single();
    const isAdmin = me?.role === "admin";
    const nm = (me?.full_name || "").trim().toLowerCase(), em = (me?.email || "").toLowerCase();
    const canCheck = !!me && (isAdmin || CHECK_NAMES.includes(nm) || CHECK_EMAILS.includes(em));
    const canResolve = !!me && (isAdmin || em === GULFAM_EMAIL);
    if (!canCheck) return json({ error: "not permitted" }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action || "load";
    const today = new Date().toISOString().slice(0, 10);

    // names of users who logged/resolved, for display
    async function nameMap(ids: string[]): Promise<Record<string, string>> {
      const u = [...new Set(ids.filter(Boolean))];
      const m: Record<string, string> = {};
      if (u.length) { const { data } = await svc.from("profiles").select("id,full_name").in("id", u); (data ?? []).forEach((r: any) => (m[r.id] = r.full_name)); }
      return m;
    }
    async function openFlags() {
      const { data } = await svc.from("boarding_checks").select("*").eq("restrictor_ok", false).eq("flag_resolved", false).order("check_date", { ascending: false });
      const rows = data ?? [];
      const roomIds = [...new Set(rows.map((r: any) => r.room_id))];
      const rmap: Record<string, string> = {};
      if (roomIds.length) { const { data: rm } = await svc.from("boarding_rooms").select("id,name").in("id", roomIds); (rm ?? []).forEach((r: any) => (rmap[r.id] = r.name)); }
      const nmap = await nameMap(rows.map((r: any) => r.checked_by));
      return rows.map((r: any) => ({ room_id: r.room_id, room_name: rmap[r.room_id] || "?", check_date: r.check_date, notes: r.notes, checked_by_name: nmap[r.checked_by] || "—" }));
    }

    if (action === "load") {
      const date = (body.date || today).slice(0, 10);
      const { data: rooms } = await svc.from("boarding_rooms").select("id,name").eq("is_active", true).order("sort");
      const { data: rows } = await svc.from("boarding_checks").select("*").eq("check_date", date);
      const checks: Record<string, any> = {};
      (rows ?? []).forEach((r: any) => (checks[r.room_id] = { bed_ok: r.bed_ok, cupboard_ok: r.cupboard_ok, carpet_ok: r.carpet_ok, light_ok: r.light_ok, switch_ok: r.switch_ok, radiator_ok: r.radiator_ok, window_ok: r.window_ok, restrictor_ok: r.restrictor_ok, notes: r.notes, flag_resolved: r.flag_resolved }));
      return json({ ok: true, date, rooms: rooms ?? [], checks, flags: await openFlags(), can_resolve: canResolve });
    }

    if (action === "save") {
      const room_id = body.room_id;
      const date = (body.date || today).slice(0, 10);
      if (!room_id) return json({ error: "room required" }, 400);
      const { data: existing } = await svc.from("boarding_checks").select("*").eq("room_id", room_id).eq("check_date", date).maybeSingle();
      const prevOpen = !!existing && existing.restrictor_ok === false && !existing.flag_resolved;
      const restrictor_ok = bool(body.restrictor_ok);
      const row: any = { room_id, check_date: date, bed_ok: bool(body.bed_ok), cupboard_ok: bool(body.cupboard_ok), carpet_ok: bool(body.carpet_ok), light_ok: bool(body.light_ok), switch_ok: bool(body.switch_ok), radiator_ok: bool(body.radiator_ok), window_ok: bool(body.window_ok), restrictor_ok, notes: (body.notes || "").trim() || null, checked_by: user.id, updated_at: new Date().toISOString() };
      if (!restrictor_ok) row.flag_resolved = false;
      const { error } = await svc.from("boarding_checks").upsert(row, { onConflict: "room_id,check_date" });
      if (error) return json({ error: error.message }, 500);

      let flagged = false;
      if (!restrictor_ok && !prevOpen) {
        flagged = true;
        try {
          const { data: room } = await svc.from("boarding_rooms").select("name").eq("id", room_id).single();
          const roomName = room?.name || "a boarding room";
          const when = new Date(date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
          const checker = me?.full_name || "a staff member";
          const { data: cfgRows } = await svc.from("app_config").select("key,value");
          const cfg: Record<string, string> = {}; (cfgRows ?? []).forEach((r: any) => (cfg[r.key] = r.value));
          const brevoReady = !!(cfg.brevo_api_key && cfg.brevo_sender_email && cfg.brevo_sender_email !== "PENDING");
          if (cfg.vapid_public) webpush.setVapidDetails(cfg.vapid_subject, cfg.vapid_public, cfg.vapid_private);
          const { data: g } = await svc.from("profiles").select("id,email,full_name").ilike("email", GULFAM_EMAIL).maybeSingle();
          const noteLine = row.notes ? `\n\nNote from ${checker}: ${row.notes}` : "";
          const text = `URGENT — window restrictor flagged\n\nA boarding check has flagged a missing or faulty window restrictor in ${roomName}.\n\nChecked by: ${checker}\nDate: ${when}${noteLine}\n\nPlease action this today.`;
          const subject = `⚠ Window restrictor flagged — ${roomName}`;
          if (brevoReady) {
            const toEmail = g?.email || GULFAM_EMAIL;
            try {
              await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": cfg.brevo_api_key, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ sender: { name: cfg.brevo_sender_name, email: cfg.brevo_sender_email }, to: [{ email: toEmail, name: g?.full_name || "Maulana Gulfam" }], subject, htmlContent: `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:auto"><h2 style="color:#9A3334">${subject}</h2><p style="white-space:pre-wrap">${text}</p><hr style="border:none;border-top:1px solid #E8E3D6"/><p style="color:#6E6A60;font-size:12px">Al Jamiatul Islamiyah — Boarding checks</p></div>` }) });
            } catch { /* ignore */ }
          }
          if (g?.id) {
            const { data: subs } = await svc.from("push_subscriptions").select("endpoint,p256dh,auth").eq("user_id", g.id);
            const payload = JSON.stringify({ title: subject, body: `${roomName}: window restrictor flagged — action today.`, url: "/", kind: "boarding" });
            for (const s of subs ?? []) { try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); } catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await svc.from("push_subscriptions").delete().eq("endpoint", s.endpoint); } }
          }
        } catch { /* notification is best-effort */ }
      }
      return json({ ok: true, flagged });
    }

    if (action === "resolve") {
      if (!canResolve) return json({ error: "not permitted" }, 403);
      const room_id = body.room_id; const date = (body.date || "").slice(0, 10);
      if (!room_id || !date) return json({ error: "room and date required" }, 400);
      const { error } = await svc.from("boarding_checks").update({ flag_resolved: true, flag_resolved_by: user.id, flag_resolved_at: new Date().toISOString() }).eq("room_id", room_id).eq("check_date", date);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, flags: await openFlags() });
    }

    if (action === "export") {
      const month = (body.month || today.slice(0, 7)).slice(0, 7);
      const from = month + "-01";
      const d = new Date(from + "T00:00:00"); const to = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
      const { data: rows } = await svc.from("boarding_checks").select("*").gte("check_date", from).lte("check_date", to).order("check_date");
      const { data: rooms } = await svc.from("boarding_rooms").select("id,name");
      const rmap: Record<string, string> = {}; (rooms ?? []).forEach((r: any) => (rmap[r.id] = r.name));
      const nmap = await nameMap((rows ?? []).map((r: any) => r.checked_by));
      const out = (rows ?? []).map((r: any) => ({ check_date: r.check_date, room_name: rmap[r.room_id] || "?", bed_ok: r.bed_ok, cupboard_ok: r.cupboard_ok, carpet_ok: r.carpet_ok, light_ok: r.light_ok, switch_ok: r.switch_ok, radiator_ok: r.radiator_ok, window_ok: r.window_ok, restrictor_ok: r.restrictor_ok, flag_resolved: r.flag_resolved, notes: r.notes, checked_by_name: nmap[r.checked_by] || "" }));
      return json({ ok: true, month, rows: out });
    }

    if (action === "add_room") {
      if (!isAdmin) return json({ error: "admins only" }, 403);
      const name = (body.name || "").trim();
      if (!name) return json({ error: "name required" }, 400);
      const { data: mx } = await svc.from("boarding_rooms").select("sort").order("sort", { ascending: false }).limit(1).maybeSingle();
      const sort = (mx?.sort || 0) + 10;
      const { data, error } = await svc.from("boarding_rooms").insert({ name, sort }).select().single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, room: data });
    }

    if (action === "set_room_active") {
      if (!isAdmin) return json({ error: "admins only" }, 403);
      if (!body.room_id) return json({ error: "room required" }, 400);
      const { error } = await svc.from("boarding_rooms").update({ is_active: bool(body.active) }).eq("id", body.room_id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
