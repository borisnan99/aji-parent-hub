// send-message — 1:1 parent <-> school messaging. Inserts the message and
// pushes the OTHER party (parent's reply pings staff; staff reply pings the parent).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });

// Mirrors the parent_hub.can_see_parent() RLS logic so a staff member can only
// start a conversation with a parent they are allowed to message.
async function canSeeParent(svc: any, staffId: string, role: string, parentId: string) {
  if (role === "admin") return true;
  const { data: acc } = await svc.from("staff_access").select("*").eq("user_id", staffId).maybeSingle();
  if (acc && (acc.is_full || acc.msg_all)) return true;
  const { data: links } = await svc.from("parent_pupil").select("pupil_id").eq("parent_id", parentId);
  const pids = (links ?? []).map((l: any) => l.pupil_id);
  if (!pids.length) return false;
  const { data: kids } = await svc.from("pupils").select("id,boarding_status,academic_year").in("id", pids);
  if (acc && acc.msg_boarders && (kids ?? []).some((k: any) => k.boarding_status === "Boarding")) return true;
  const SY = ["Year 7", "Year 8", "Year 9", "Year 10", "Year 11"];
  if (acc && acc.msg_school && (kids ?? []).some((k: any) => SY.includes(k.academic_year))) return true;
  const { data: ct } = await svc.from("class_teachers").select("class_id,can_message").eq("user_id", staffId);
  const mine = (ct ?? []).filter((c: any) => c.can_message).map((c: any) => c.class_id);
  if (mine.length) {
    const { data: enr } = await svc.from("class_enrolments").select("pupil_id,class_id").in("pupil_id", pids);
    if ((enr ?? []).some((e: any) => mine.includes(e.class_id))) return true;
  }
  return false;
}

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
    const { data: me } = await svc.from("profiles").select("role,full_name").eq("id", user.id).single();
    if (!me) return json({ error: "no profile" }, 403);
    const isStaff = ["admin", "staff"].includes(me.role);

    let { conversation_id, body, subject, parent_id } = await req.json();
    if (!body || !body.trim()) return json({ error: "empty message" }, 400);

    // resolve the conversation
    let conv;
    if (conversation_id) {
      const { data } = await svc.from("conversations").select("*").eq("id", conversation_id).single();
      conv = data;
      if (!conv) return json({ error: "conversation not found" }, 404);
      if (!isStaff && conv.parent_id !== user.id) return json({ error: "not your conversation" }, 403);
    } else if (isStaff) {
      if (!parent_id) return json({ error: "parent_id required to start a conversation" }, 400);
      const allowed = await canSeeParent(svc, user.id, me.role, parent_id);
      if (!allowed) return json({ error: "You are not allowed to message this parent" }, 403);
      const { data: existing } = await svc.from("conversations")
        .select("*").eq("parent_id", parent_id).eq("status", "open")
        .order("last_message_at", { ascending: false }).limit(1);
      conv = existing?.[0];
      if (!conv) {
        const { data: made } = await svc.from("conversations")
          .insert({ parent_id, subject: subject || "Message from the school" }).select().single();
        conv = made;
      }
    } else {
      const { data: existing } = await svc.from("conversations")
        .select("*").eq("parent_id", user.id).eq("status", "open")
        .order("last_message_at", { ascending: false }).limit(1);
      conv = existing?.[0];
      if (!conv) {
        const { data: made } = await svc.from("conversations")
          .insert({ parent_id: user.id, subject: subject || "Message to school" }).select().single();
        conv = made;
      }
    }

    await svc.from("messages").insert({
      conversation_id: conv.id, sender_id: user.id,
      sender_role: isStaff ? "staff" : "parent", body: body.trim(),
      read_by_staff: isStaff, read_by_parent: !isStaff,
    });
    await svc.from("conversations").update({ last_message_at: new Date().toISOString(), status: "open" }).eq("id", conv.id);

    // push the other side
    const { data: cfgRows } = await svc.from("app_config").select("key,value");
    const cfg: Record<string, string> = {};
    (cfgRows ?? []).forEach((r: any) => (cfg[r.key] = r.value));
    webpush.setVapidDetails(cfg.vapid_subject, cfg.vapid_public, cfg.vapid_private);

    let targetIds: string[] = [];
    if (isStaff) targetIds = [conv.parent_id];
    else {
      const { data: staff } = await svc.from("profiles").select("id").in("role", ["admin", "staff"]);
      targetIds = (staff ?? []).map((s: any) => s.id);
    }
    const preview = body.trim().slice(0, 120);
    const payload = JSON.stringify({
      title: isStaff ? "Message from the school" : `New message from ${me.full_name}`,
      body: preview, url: "/", kind: "message",
    });
    let pushSent = 0;
    for (const tid of targetIds) {
      const { data: subs } = await svc.from("push_subscriptions").select("endpoint,p256dh,auth").eq("user_id", tid);
      for (const s of subs ?? []) {
        try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); pushSent++; }
        catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await svc.from("push_subscriptions").delete().eq("endpoint", s.endpoint); }
      }
    }
    return json({ ok: true, conversation_id: conv.id, push_sent: pushSent });
  } catch (e: any) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
