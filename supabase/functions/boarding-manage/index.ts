// boarding-manage — boarding room occupants, weekly cleaning rota, and the damage log.
//  • Occupants & rota & room frequency: admins only.
//  • Damage log: admins + the boarding team who log damage (Ihsaanul Haque, Gulfam Khan,
//    Zubair Patel, Yasin Patel). Delete: admins only.
// Rota is a repeating weekly pattern (dow 1=Mon .. 7=Sun). Each room has one occupant marked as
// the room representative.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const clean = (v: unknown) => { const s = (typeof v === "string" ? v : "").trim(); return s || null; };

const DAMAGE_NAMES = ["ihsaanul haque", "gulfam khan", "zubair patel", "yasin patel"];
const DAMAGE_EMAILS = ["ihsaanul.haque@boltondarululoom.org.uk", "gulfam.khan@boltondarululoom.org.uk", "zubair.patel@boltondarululoom.org.uk", "yasin.patel@boltondarululoom.org.uk"];

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
    const canDamage = !!me && (isAdmin || DAMAGE_NAMES.includes(nm) || DAMAGE_EMAILS.includes(em));
    const canCheck = !!me && (isAdmin || ["ihsaanul haque", "gulfam khan"].includes(nm) || canDamage);
    if (!canCheck) return json({ error: "not permitted" }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action || "roster";

    async function pupilNames(ids: string[]): Promise<Record<string, string>> {
      const u = [...new Set(ids.filter(Boolean))]; const m: Record<string, string> = {};
      if (u.length) { const { data } = await svc.from("pupils").select("id,first_name,last_name").in("id", u); (data ?? []).forEach((r: any) => (m[r.id] = `${r.first_name} ${r.last_name}`)); }
      return m;
    }
    async function roomsList() {
      const { data } = await svc.from("boarding_rooms").select("id,name,block,check_frequency,sort,is_active").eq("is_active", true).order("sort");
      return data ?? [];
    }

    if (action === "roster") {
      const { data: pupils } = await svc.from("pupils").select("id,first_name,last_name").eq("is_active", true).eq("boarding_status", "Boarding").order("last_name");
      const { data: occ } = await svc.from("boarding_room_occupants").select("room_id,pupil_id");
      const rooms = await roomsList();
      const rmap: Record<string, string> = {}; rooms.forEach((r: any) => (rmap[r.id] = r.name));
      const roomOf: Record<string, string> = {}; (occ ?? []).forEach((o: any) => { if (!roomOf[o.pupil_id]) roomOf[o.pupil_id] = rmap[o.room_id] || ""; });
      const boarders = (pupils ?? []).map((p: any) => ({ id: p.id, name: `${p.first_name} ${p.last_name}`, room: roomOf[p.id] || "" }));
      return json({ ok: true, boarders, rooms });
    }

    if (action === "occupants_get") {
      const { data } = await svc.from("boarding_room_occupants").select("pupil_id,is_rep,sort").eq("room_id", body.room_id).order("sort");
      const pmap = await pupilNames((data ?? []).map((o: any) => o.pupil_id));
      return json({ ok: true, occupants: (data ?? []).map((o: any) => ({ pupil_id: o.pupil_id, name: pmap[o.pupil_id] || "?", is_rep: o.is_rep, sort: o.sort })) });
    }

    if (action === "occupant_add") {
      if (!isAdmin) return json({ error: "admins only" }, 403);
      if (!body.room_id || !body.pupil_id) return json({ error: "room and pupil required" }, 400);
      const { data: mx } = await svc.from("boarding_room_occupants").select("sort").eq("room_id", body.room_id).order("sort", { ascending: false }).limit(1).maybeSingle();
      const sort = (mx?.sort || 0) + 1;
      const { error } = await svc.from("boarding_room_occupants").upsert({ room_id: body.room_id, pupil_id: body.pupil_id, sort }, { onConflict: "room_id,pupil_id" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "occupant_remove") {
      if (!isAdmin) return json({ error: "admins only" }, 403);
      if (!body.room_id || !body.pupil_id) return json({ error: "room and pupil required" }, 400);
      await svc.from("boarding_room_occupants").delete().eq("room_id", body.room_id).eq("pupil_id", body.pupil_id);
      // also drop from this room's rota
      await svc.from("boarding_cleaning_rota").delete().eq("room_id", body.room_id).eq("pupil_id", body.pupil_id);
      return json({ ok: true });
    }

    if (action === "set_rep") {
      if (!isAdmin) return json({ error: "admins only" }, 403);
      if (!body.room_id) return json({ error: "room required" }, 400);
      await svc.from("boarding_room_occupants").update({ is_rep: false }).eq("room_id", body.room_id);
      if (body.pupil_id) { const { error } = await svc.from("boarding_room_occupants").update({ is_rep: true }).eq("room_id", body.room_id).eq("pupil_id", body.pupil_id); if (error) return json({ error: error.message }, 500); }
      return json({ ok: true });
    }

    if (action === "rota_get" || action === "rota_room") {
      if (!body.room_id) return json({ error: "room required" }, 400);
      const { data: room } = await svc.from("boarding_rooms").select("id,name").eq("id", body.room_id).single();
      const { data: occ } = await svc.from("boarding_room_occupants").select("pupil_id,is_rep,sort").eq("room_id", body.room_id).order("sort");
      const { data: rota } = await svc.from("boarding_cleaning_rota").select("dow,pupil_id,sort").eq("room_id", body.room_id).order("dow").order("sort");
      const pmap = await pupilNames([...(occ ?? []).map((o: any) => o.pupil_id), ...(rota ?? []).map((r: any) => r.pupil_id)]);
      const byDow: Record<string, any[]> = {};
      for (let d = 1; d <= 7; d++) byDow[d] = [];
      (rota ?? []).forEach((r: any) => byDow[r.dow].push({ pupil_id: r.pupil_id, name: pmap[r.pupil_id] || "?" }));
      const repRow = (occ ?? []).find((o: any) => o.is_rep);
      // per-pupil day counts
      const counts: Record<string, number> = {};
      (rota ?? []).forEach((r: any) => (counts[r.pupil_id] = (counts[r.pupil_id] || 0) + 1));
      const occupants = (occ ?? []).map((o: any) => ({ pupil_id: o.pupil_id, name: pmap[o.pupil_id] || "?", is_rep: o.is_rep, days: counts[o.pupil_id] || 0 }));
      return json({ ok: true, room_name: room?.name || "", rep: repRow ? { pupil_id: repRow.pupil_id, name: pmap[repRow.pupil_id] || "?" } : null, by_dow: byDow, occupants });
    }

    if (action === "rota_set") {
      if (!isAdmin) return json({ error: "admins only" }, 403);
      const { room_id, dow } = body;
      if (!room_id || !dow) return json({ error: "room and day required" }, 400);
      const pids: string[] = Array.isArray(body.pupil_ids) ? body.pupil_ids : [];
      await svc.from("boarding_cleaning_rota").delete().eq("room_id", room_id).eq("dow", dow);
      if (pids.length) {
        const rows = pids.map((pid, i) => ({ room_id, dow, pupil_id: pid, sort: i + 1 }));
        const { error } = await svc.from("boarding_cleaning_rota").insert(rows);
        if (error) return json({ error: error.message }, 500);
      }
      return json({ ok: true });
    }

    if (action === "damage_list") {
      const scope = body.scope || "open";
      let qy = svc.from("boarding_damage_log").select("*").order("log_date", { ascending: false }).order("created_at", { ascending: false });
      if (scope === "open") qy = qy.eq("money_received", false);
      else if (scope === "month") { const month = (body.month || new Date().toISOString().slice(0, 7)).slice(0, 7); const from = month + "-01"; const d = new Date(from + "T00:00:00"); const to = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10); qy = qy.gte("log_date", from).lte("log_date", to); }
      const { data: rows } = await qy;
      const roomIds = [...new Set((rows ?? []).map((r: any) => r.room_id).filter(Boolean))];
      const rmap: Record<string, string> = {};
      if (roomIds.length) { const { data: rm } = await svc.from("boarding_rooms").select("id,name").in("id", roomIds); (rm ?? []).forEach((r: any) => (rmap[r.id] = r.name)); }
      const pmap = await pupilNames((rows ?? []).map((r: any) => r.pupil_id).filter(Boolean));
      const out = (rows ?? []).map((r: any) => ({ ...r, room_name: r.room_id ? (rmap[r.room_id] || "?") : (r.area || ""), pupil_name: r.pupil_id ? (pmap[r.pupil_id] || "?") : "" }));
      const openTotal = (rows ?? []).filter((r: any) => !r.money_received).reduce((a: number, r: any) => a + (Number(r.replacement_cost) || 0), 0);
      return json({ ok: true, rows: out, open_total: openTotal });
    }

    if (action === "damage_add") {
      if (!canDamage) return json({ error: "not permitted" }, 403);
      const item = clean(body.item); if (!item) return json({ error: "item required" }, 400);
      let reported_by: string | null = null;
      const rbName = clean(body.reported_by_name);
      if (rbName) { const { data: pr } = await svc.from("profiles").select("id").ilike("full_name", rbName).maybeSingle(); reported_by = pr?.id || null; }
      const row: any = {
        log_date: (body.log_date || new Date().toISOString().slice(0, 10)).slice(0, 10),
        room_id: body.room_id || null, area: clean(body.area), item, item_other: clean(body.item_other),
        description: clean(body.description), pupil_id: body.pupil_id || null,
        reported_by, reported_by_name: rbName,
        replacement_cost: body.replacement_cost != null && body.replacement_cost !== "" ? Number(body.replacement_cost) : null,
        money_received: body.money_received === true, money_received_note: clean(body.money_received_note),
        logged_by: user.id, updated_at: new Date().toISOString(),
      };
      const { data, error } = await svc.from("boarding_damage_log").insert(row).select().single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, id: data.id });
    }

    if (action === "damage_update") {
      if (!canDamage) return json({ error: "not permitted" }, 403);
      if (!body.id) return json({ error: "id required" }, 400);
      const patch: any = { updated_at: new Date().toISOString() };
      if ("money_received" in body) patch.money_received = body.money_received === true;
      if ("money_received_note" in body) patch.money_received_note = clean(body.money_received_note);
      if ("replacement_cost" in body) patch.replacement_cost = body.replacement_cost != null && body.replacement_cost !== "" ? Number(body.replacement_cost) : null;
      if ("description" in body) patch.description = clean(body.description);
      const { error } = await svc.from("boarding_damage_log").update(patch).eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "damage_delete") {
      if (!isAdmin) return json({ error: "admins only" }, 403);
      if (!body.id) return json({ error: "id required" }, 400);
      await svc.from("boarding_damage_log").delete().eq("id", body.id);
      return json({ ok: true });
    }

    if (action === "rooms") { return json({ ok: true, rooms: await roomsList() }); }

    return json({ error: "unknown action" }, 400);
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
