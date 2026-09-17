// notify-late — parent alert when a pupil is marked Late (in-app + email + push),
// de-duped per pupil/date/session. On the 2nd MORNING late within a Mon–Fri week,
// automatically assigns a Saturday detention and notifies the parent.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });

const LABEL: Record<string, string> = { morning: "morning class", afternoon: "school", evening: "Mutala", night: "the night register" };
const DETENTION_THRESHOLD = 2; // morning lates in a Mon–Fri week

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "parent_hub" } });
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      db: { schema: "parent_hub" }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);
    const { data: me } = await svc.from("profiles").select("role").eq("id", user.id).single();
    if (!me || !["admin", "staff"].includes(me.role)) return json({ error: "staff only" }, 403);

    const { pupil_ids, phase, minutes, on_date } = await req.json();
    if (!Array.isArray(pupil_ids) || !pupil_ids.length) return json({ error: "no pupils" }, 400);
    const date = on_date || new Date().toISOString().slice(0, 10);
    const mins = Math.max(1, Math.round(Number(minutes) || 1));
    const label = LABEL[phase] || "madrasa";

    const { data: cfgRows } = await svc.from("app_config").select("key,value");
    const cfg: Record<string, string> = {};
    (cfgRows ?? []).forEach((r: any) => (cfg[r.key] = r.value));
    const brevoReady = cfg.brevo_api_key && cfg.brevo_sender_email && cfg.brevo_sender_email !== "PENDING";
    if (cfg.vapid_public) webpush.setVapidDetails(cfg.vapid_subject, cfg.vapid_public, cfg.vapid_private);

    // helper: post a message to each parent's conversation + email + push
    async function messageParents(parentIds: string[], childName: string, bodyText: string, subject: string, pushBody: string) {
      let emailed = 0, pushed = 0;
      for (const parentId of parentIds) {
        const { data: prof } = await svc.from("profiles").select("email,full_name").eq("id", parentId).single();
        let conv;
        const { data: existing } = await svc.from("conversations").select("*").eq("parent_id", parentId).order("last_message_at", { ascending: false }).limit(1);
        conv = existing?.[0];
        if (!conv) { const { data: made } = await svc.from("conversations").insert({ parent_id: parentId, subject: "Attendance" }).select().single(); conv = made; }
        await svc.from("messages").insert({ conversation_id: conv.id, sender_id: user.id, sender_role: "staff", body: bodyText, read_by_staff: true, read_by_parent: false });
        await svc.from("conversations").update({ last_message_at: new Date().toISOString(), status: "open" }).eq("id", conv.id);
        if (brevoReady && prof?.email) {
          try {
            const r = await fetch("https://api.brevo.com/v3/smtp/email", {
              method: "POST",
              headers: { "api-key": cfg.brevo_api_key, "content-type": "application/json", accept: "application/json" },
              body: JSON.stringify({
                sender: { name: cfg.brevo_sender_name, email: cfg.brevo_sender_email },
                to: [{ email: prof.email, name: prof.full_name }],
                subject,
                htmlContent: `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:auto"><h2 style="color:#14294D">${subject}</h2><p style="white-space:pre-wrap">${bodyText}</p><hr style="border:none;border-top:1px solid #E8E3D6"/><p style="color:#6E6A60;font-size:12px">Al Jamiatul Islamiyah — Bolton Darul Uloom</p></div>`,
              }),
            });
            if (r.ok) emailed++;
          } catch { /* ignore */ }
        }
        const { data: subs } = await svc.from("push_subscriptions").select("endpoint,p256dh,auth").eq("user_id", parentId);
        const payload = JSON.stringify({ title: subject, body: pushBody, url: "/", kind: "message" });
        for (const s of subs ?? []) {
          try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); pushed++; }
          catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await svc.from("push_subscriptions").delete().eq("endpoint", s.endpoint); }
        }
      }
      return { emailed, pushed };
    }

    let notified = 0, emailed = 0, pushed = 0, skipped = 0, detentions = 0;

    for (const pid of pupil_ids) {
      const { data: att } = await svc.from("attendance").select("late_notified_at").eq("pupil_id", pid).eq("on_date", date).eq("phase", phase).maybeSingle();
      const already = !!att?.late_notified_at;

      const { data: pupil } = await svc.from("pupils").select("first_name,last_name").eq("id", pid).single();
      if (!pupil) { skipped++; continue; }
      const childName = `${pupil.first_name} ${pupil.last_name}`;
      const { data: pp } = await svc.from("parent_pupil").select("parent_id").eq("pupil_id", pid);
      const parentIds = (pp ?? []).map((x: any) => x.parent_id);
      if (!parentIds.length) { skipped++; continue; }

      // 1) lateness alert (only once per pupil/date/session)
      if (!already) {
        const bodyText =
`Assalamu alaikum,

This is a message from Al Jamiatul Islamiyah.

Your son ${childName} arrived late to ${label} today by ${mins} minute${mins === 1 ? "" : "s"}.

May we kindly remind you that it is the responsibility of parents to ensure their child arrives on time. Punctuality is an important part of your child's education and character.

Please note: if a child arrives late twice in a week (morning class), they will automatically be assigned a detention on Saturday.

JazakAllahu khairan for your cooperation in this matter.`;
        const r = await messageParents(parentIds, childName, bodyText, `Lateness notice — ${childName}`, `${childName} arrived ${mins} min late to ${label}.`);
        emailed += r.emailed; pushed += r.pushed;
        await svc.from("attendance").update({ late_notified_at: new Date().toISOString() }).eq("pupil_id", pid).eq("on_date", date).eq("phase", phase);
        notified++;
      }

      // 2) detention trigger — MORNING lates only, Mon–Fri window.
      // Exclude pupils whose morning class runs on Saturday (Arbi Sowm / Chahaarum):
      // a Saturday detention is no consequence for them.
      let satClass = false;
      if (phase === "morning") {
        const { data: enr } = await svc.from("class_enrolments").select("class_id").eq("pupil_id", pid);
        const classIds = (enr ?? []).map((e: any) => e.class_id);
        if (classIds.length) {
          const { data: cls } = await svc.from("classes").select("saturday_class").in("id", classIds);
          satClass = (cls ?? []).some((c: any) => c.saturday_class);
        }
      }
      if (phase === "morning" && !satClass) {
        const d = new Date(date + "T00:00:00Z");
        const dow = d.getUTCDay();                 // 0 Sun .. 6 Sat
        const toMon = dow === 0 ? -6 : 1 - dow;
        const monday = new Date(d); monday.setUTCDate(d.getUTCDate() + toMon);
        const friday = new Date(monday); friday.setUTCDate(monday.getUTCDate() + 4);
        const saturday = new Date(monday); saturday.setUTCDate(monday.getUTCDate() + 5);
        const wk = monday.toISOString().slice(0, 10), fri = friday.toISOString().slice(0, 10), sat = saturday.toISOString().slice(0, 10);
        const { data: lates } = await svc.from("attendance").select("on_date")
          .eq("pupil_id", pid).eq("phase", "morning").eq("status", "late").gte("on_date", wk).lte("on_date", fri);
        const cnt = (lates ?? []).length;
        if (cnt >= DETENTION_THRESHOLD) {
          const { data: exists } = await svc.from("detentions").select("id").eq("pupil_id", pid).eq("week_start", wk).maybeSingle();
          if (!exists) {
            const { data: det } = await svc.from("detentions").insert({
              pupil_id: pid, week_start: wk, detention_date: sat, late_count: cnt,
              reason: `${cnt} morning lates this week`, created_by: user.id,
            }).select().single();
            const detBody =
`Assalamu alaikum,

This is a message from Al Jamiatul Islamiyah.

As your son ${childName} has now arrived late to morning class ${cnt} times this week, he has been assigned a detention this Saturday (${sat}), in line with school policy.

We kindly ask for your continued support in ensuring he arrives to madrasa on time.

JazakAllahu khairan for your cooperation.`;
            await messageParents(parentIds, childName, detBody, `Detention notice — ${childName}`, `${childName} has a Saturday detention (${sat}).`);
            if (det) await svc.from("detentions").update({ notified_at: new Date().toISOString() }).eq("id", det.id);
            detentions++;
          }
        }
      }
    }

    return json({ notified, emailed, pushed, skipped, detentions });
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
