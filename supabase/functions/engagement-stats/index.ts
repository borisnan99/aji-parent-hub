// engagement-stats — admin-only parent buy-in metrics.
// Returns, per parent family: notifications on? active in messages? plus totals.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });

async function pageAll(q: any) {
  let all: any[] = [], off = 0;
  while (true) {
    const { data, error } = await q.range(off, off + 999);
    if (error || !data || !data.length) break;
    all = all.concat(data);
    if (data.length < 1000) break;
    off += 1000;
  }
  return all;
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
    const { data: me } = await svc.from("profiles").select("role").eq("id", user.id).single();
    const { data: acc } = await svc.from("staff_access").select("is_full").eq("user_id", user.id).maybeSingle();
    if (!me || (me.role !== "admin" && !(acc && acc.is_full))) return json({ error: "admins only" }, 403);

    const parents = await pageAll(svc.from("profiles").select("id,full_name").eq("role", "parent"));
    const subs = await pageAll(svc.from("push_subscriptions").select("user_id"));
    const convs = await pageAll(svc.from("conversations").select("id,parent_id"));
    const msgs = await pageAll(svc.from("messages").select("conversation_id,sender_role,read_by_parent"));

    const convParent: Record<string, string> = {};
    convs.forEach((c: any) => (convParent[c.id] = c.parent_id));
    const pushSet = new Set(subs.map((s: any) => s.user_id));
    const activeSet = new Set<string>();
    msgs.forEach((m: any) => {
      const pid = convParent[m.conversation_id];
      if (!pid) return;
      // active = parent has read a staff message OR sent a message themselves
      if (m.sender_role === "parent") activeSet.add(pid);
      if (m.read_by_parent) activeSet.add(pid);
    });

    let push = 0, active = 0, connected = 0;
    const list = parents.map((p: any) => {
      const hasPush = pushSet.has(p.id);
      const isActive = activeSet.has(p.id);
      if (hasPush) push++;
      if (isActive) active++;
      if (hasPush || isActive) connected++;
      return { id: p.id, name: p.full_name, push: hasPush, active: isActive };
    }).sort((a: any, b: any) => (a.push || a.active ? 1 : 0) - (b.push || b.active ? 1 : 0) || String(a.name).localeCompare(String(b.name)));

    return json({ total: parents.length, push, active, connected, parents: list });
  } catch (e: any) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
