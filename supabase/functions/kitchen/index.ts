// kitchen — food-safety management (SFBB / HACCP aligned): daily checks, temps, cleaning,
// recipes, pupil allergies/diets, COSHH register, kitchen incidents. Access: admins + kitchen staff.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const KITCHEN_NAMES = ["kulsum"]; // matched as substrings of full_name; admins always have access
const passFor = (kind: string, t: number) => (kind === "cooking" || kind === "reheating") ? t >= 75 : kind === "hot_hold" ? t >= 63 : kind === "cold_hold" ? t <= 8 : null;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "parent_hub" } });
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { db: { schema: "parent_hub" }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);
    const { data: me } = await svc.from("profiles").select("role,full_name").eq("id", user.id).single();
    const nm = (me?.full_name || "").trim().toLowerCase();
    const isAdmin = me?.role === "admin";
    if (!me || !(isAdmin || KITCHEN_NAMES.some((k) => nm.includes(k)))) return json({ error: "not permitted" }, 403);
    const body = await req.json().catch(() => ({}));
    const action = body.action || "daily_load";
    const today = new Date().toISOString().slice(0, 10);

    async function nameMap(ids: string[]) {
      const u = [...new Set(ids.filter(Boolean))]; const m: Record<string, string> = {};
      if (u.length) { const { data } = await svc.from("profiles").select("id,full_name").in("id", u); (data ?? []).forEach((p: any) => (m[p.id] = p.full_name)); }
      return m;
    }

    // ---- DAILY DIARY ----
    if (action === "daily_load") {
      const date = (body.date || today).slice(0, 10);
      const { data: day } = await svc.from("kitchen_daily").select("*").eq("log_date", date).maybeSingle();
      const { data: temps } = await svc.from("kitchen_temps").select("*").eq("log_date", date).order("taken_at");
      const nm2 = await nameMap([day?.open_by, day?.close_by, ...(temps ?? []).map((t: any) => t.taken_by)]);
      const dayOut = day ? { ...day, open_by_name: nm2[day.open_by] || "", close_by_name: nm2[day.close_by] || "" } : null;
      const tempsOut = (temps ?? []).map((t: any) => ({ ...t, taken_by_name: nm2[t.taken_by] || "" }));
      return json({ ok: true, date, day: dayOut, temps: tempsOut });
    }
    if (action === "daily_open" || action === "daily_close") {
      const date = (body.date || today).slice(0, 10);
      const pre = action === "daily_open" ? "open" : "close";
      const row: any = { log_date: date, updated_at: new Date().toISOString() };
      row[pre + "_fridge"] = body.fridge === "" || body.fridge == null ? null : Number(body.fridge);
      row[pre + "_freezer"] = body.freezer === "" || body.freezer == null ? null : Number(body.freezer);
      row[pre + "_safe_methods"] = body.safe_methods === true;
      row[pre + "_notes"] = (body.notes || "").trim() || null;
      row[pre + "_by"] = user.id; row[pre + "_at"] = new Date().toISOString();
      const { error } = await svc.from("kitchen_daily").upsert(row, { onConflict: "log_date" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (action === "daily_meta") {
      const date = (body.date || today).slice(0, 10);
      const row: any = { log_date: date, updated_at: new Date().toISOString() };
      if (body.catered !== undefined) row.catered = body.catered === true;
      if (body.extra_checks !== undefined) row.extra_checks = (body.extra_checks || "").trim() || null;
      const { error } = await svc.from("kitchen_daily").upsert(row, { onConflict: "log_date" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (action === "temp_add") {
      const date = (body.date || today).slice(0, 10);
      const kind = body.kind || "cooking";
      const t = Number(body.temp);
      if (!body.item || isNaN(t)) return json({ error: "item and temperature are required" }, 400);
      const { data, error } = await svc.from("kitchen_temps").insert({ log_date: date, kind, item: (body.item || "").trim(), temp_c: t, pass: passFor(kind, t), taken_by: user.id, notes: (body.notes || "").trim() || null }).select().single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, id: data.id });
    }
    if (action === "temp_delete") {
      if (!body.id) return json({ error: "id required" }, 400);
      const { error } = await svc.from("kitchen_temps").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ---- CLEANING ----
    if (action === "clean_load") {
      const freq = body.frequency || "daily";
      const date = (body.date || today).slice(0, 10);
      const { data: tasks } = await svc.from("kitchen_clean_tasks").select("*").eq("frequency", freq).eq("is_active", true).order("sort");
      if (freq === "daily") {
        const { data: log } = await svc.from("kitchen_clean_log").select("*").eq("done_date", date);
        const done: Record<string, any> = {}; (log ?? []).forEach((l: any) => (done[l.task_id] = l));
        return json({ ok: true, frequency: freq, date, tasks: (tasks ?? []).map((t: any) => ({ ...t, done: !!done[t.id], done_at: done[t.id]?.created_at || null })) });
      }
      // weekly/termly: last done date per task
      const ids = (tasks ?? []).map((t: any) => t.id);
      const last: Record<string, string> = {};
      if (ids.length) { const { data: log } = await svc.from("kitchen_clean_log").select("task_id,done_date").in("task_id", ids).order("done_date", { ascending: false }); (log ?? []).forEach((l: any) => { if (!last[l.task_id]) last[l.task_id] = l.done_date; }); }
      return json({ ok: true, frequency: freq, date, tasks: (tasks ?? []).map((t: any) => ({ ...t, last_done: last[t.id] || null })) });
    }
    if (action === "clean_toggle") {
      const date = (body.date || today).slice(0, 10);
      if (!body.task_id) return json({ error: "task_id required" }, 400);
      if (body.done === false) { await svc.from("kitchen_clean_log").delete().eq("task_id", body.task_id).eq("done_date", date); return json({ ok: true }); }
      const { error } = await svc.from("kitchen_clean_log").upsert({ task_id: body.task_id, done_date: date, done_by: user.id, notes: (body.notes || "").trim() || null }, { onConflict: "task_id,done_date" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (action === "clean_add") {
      if (!isAdmin) return json({ error: "admin only" }, 403);
      if (!body.title) return json({ error: "title required" }, 400);
      const { error } = await svc.from("kitchen_clean_tasks").insert({ title: (body.title || "").trim(), frequency: body.frequency || "daily", area: (body.area || "").trim() || null, sort: Number(body.sort) || 100 });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (action === "clean_remove") {
      if (!isAdmin) return json({ error: "admin only" }, 403);
      await svc.from("kitchen_clean_tasks").update({ is_active: false }).eq("id", body.id);
      return json({ ok: true });
    }

    // ---- RECIPES ----
    if (action === "recipes_list") {
      const { data } = await svc.from("kitchen_recipes").select("*").order("name");
      return json({ ok: true, rows: data ?? [] });
    }
    if (action === "recipe_save") {
      if (!body.name) return json({ error: "name required" }, 400);
      const row: any = { name: (body.name || "").trim(), category: (body.category || "").trim() || null, serves: (body.serves || "").trim() || null, ingredients: (body.ingredients || "").trim() || null, method: (body.method || "").trim() || null, allergens: (body.allergens || "").trim() || null, notes: (body.notes || "").trim() || null, updated_at: new Date().toISOString() };
      if (body.id) { const { error } = await svc.from("kitchen_recipes").update(row).eq("id", body.id); if (error) return json({ error: error.message }, 500); return json({ ok: true, id: body.id }); }
      row.created_by = user.id;
      const { data, error } = await svc.from("kitchen_recipes").insert(row).select().single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, id: data.id });
    }
    if (action === "recipe_delete") { await svc.from("kitchen_recipes").delete().eq("id", body.id); return json({ ok: true }); }

    // ---- PUPIL ALLERGIES / DIETS (health-related) ----
    if (action === "diet_list") {
      const { data: pupils } = await svc.from("pupils").select("id,first_name,last_name,academic_year").eq("is_active", true).order("last_name");
      const { data: diet } = await svc.from("pupil_dietary").select("*");
      const dm: Record<string, any> = {}; (diet ?? []).forEach((d: any) => (dm[d.pupil_id] = d));
      const rows = (pupils ?? []).map((p: any) => ({ pupil_id: p.id, name: `${p.first_name} ${p.last_name}`, academic_year: p.academic_year, allergies: dm[p.id]?.allergies || "", dietary: dm[p.id]?.dietary || "", epipen: dm[p.id]?.epipen || false, notes: dm[p.id]?.notes || "", has: !!dm[p.id] }));
      return json({ ok: true, rows });
    }
    if (action === "diet_save") {
      if (!body.pupil_id) return json({ error: "pupil required" }, 400);
      const { error } = await svc.from("pupil_dietary").upsert({ pupil_id: body.pupil_id, allergies: (body.allergies || "").trim() || null, dietary: (body.dietary || "").trim() || null, epipen: body.epipen === true, notes: (body.notes || "").trim() || null, updated_by: user.id, updated_at: new Date().toISOString() }, { onConflict: "pupil_id" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ---- COSHH ----
    if (action === "coshh_list") {
      const { data } = await svc.from("kitchen_coshh").select("*").eq("is_active", true).order("product");
      return json({ ok: true, rows: data ?? [] });
    }
    if (action === "coshh_save") {
      if (!body.product) return json({ error: "product required" }, 400);
      const row: any = { product: (body.product || "").trim(), use_for: (body.use_for || "").trim() || null, hazards: (body.hazards || "").trim() || null, precautions: (body.precautions || "").trim() || null, storage_location: (body.storage_location || "").trim() || null, msds_url: (body.msds_url || "").trim() || null };
      if (body.id) { const { error } = await svc.from("kitchen_coshh").update(row).eq("id", body.id); if (error) return json({ error: error.message }, 500); return json({ ok: true, id: body.id }); }
      const { data, error } = await svc.from("kitchen_coshh").insert(row).select().single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, id: data.id });
    }
    if (action === "coshh_delete") { await svc.from("kitchen_coshh").update({ is_active: false }).eq("id", body.id); return json({ ok: true }); }

    // ---- INCIDENTS ----
    if (action === "incident_add") {
      const { data, error } = await svc.from("kitchen_incidents").insert({ incident_date: (body.incident_date || today).slice(0, 10), kind: body.kind || "accident", what_happened: (body.what_happened || "").trim() || null, action_taken: (body.action_taken || "").trim() || null, logged_by: user.id }).select().single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, id: data.id });
    }
    if (action === "incident_list") {
      const { data } = await svc.from("kitchen_incidents").select("*").order("incident_date", { ascending: false }).limit(100);
      const nm2 = await nameMap((data ?? []).map((r: any) => r.logged_by));
      return json({ ok: true, rows: (data ?? []).map((r: any) => ({ ...r, logged_by_name: nm2[r.logged_by] || "" })) });
    }

    // ---- MONTH EXPORT (daily diary + temps) ----
    if (action === "month_export") {
      const month = (body.month || today.slice(0, 7)).slice(0, 7);
      const from = month + "-01";
      const d = new Date(from + "T00:00:00Z");
      const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      const { data: days } = await svc.from("kitchen_daily").select("*").gte("log_date", from).lte("log_date", to).order("log_date");
      const { data: temps } = await svc.from("kitchen_temps").select("*").gte("log_date", from).lte("log_date", to).order("log_date");
      const nm2 = await nameMap([...(days ?? []).flatMap((x: any) => [x.open_by, x.close_by])]);
      const daysOut = (days ?? []).map((x: any) => ({ ...x, open_by_name: nm2[x.open_by] || "", close_by_name: nm2[x.close_by] || "" }));
      return json({ ok: true, month, days: daysOut, temps: temps ?? [] });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
