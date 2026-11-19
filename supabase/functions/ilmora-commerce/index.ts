import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
const fail = (message: string, status = 400) => json({ error: message }, status);
const url = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY")!;
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

async function getUser(req: Request) {
  const h = req.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}
async function requireAdmin(req: Request) {
  const user = await getUser(req);
  if (!user) throw new Error("Please sign in again.");
  const { data: profile, error } = await admin.from("profiles").select("id,email,role").eq("id", user.id).maybeSingle();
  if (error || !["admin", "super_admin"].includes(profile?.role || "")) {
    throw new Error("Administrator access required.");
  }
  return user;
}
async function requireSuperAdmin(req: Request) {
  const user = await requireAdmin(req);
  const { data: profile, error } = await admin.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (error || profile?.role !== "super_admin") throw new Error("Owner-level administrator access required.");
  return user;
}
async function notifyAdmins(orderId: string, title: string, message: string) {
  try {
    const { data: admins, error: adminsError } = await admin.from("profiles").select("id,email").in("role", ["admin", "super_admin"]);
    if (adminsError) throw adminsError;
    if (!admins?.length) return;
    const { error } = await admin.from("notifications").insert(admins.map((person: { id: string; email: string }) => ({
      user_id: person.id, recipient_email: person.email, order_id: orderId,
      channel: "in_app", title, body: message, status: "unread",
    })));
    if (error) throw error;
  } catch (error) {
    console.error("Could not save admin notification:", error);
  }
}
async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
}
function newReference() {
  return "ILM-" + Date.now().toString(36).toUpperCase() + "-" + [...crypto.getRandomValues(new Uint8Array(4))].map(x => x.toString(16).padStart(2,"0")).join("").toUpperCase();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail("POST required.", 405);
  try {
    const body = await req.json();
    const action = String(body.action || "");

    if (action === "create_order") {
      const method = body.method === "opay" ? "opay" : body.method === "bank_transfer" ? "bank_transfer" : "";
      if (!method) return fail("Choose bank transfer or OPay.");
      const email = String(body.email || "").trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Enter a valid email address.");
      if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20) return fail("Your cart is empty or too large.");
      const quantities = new Map<string, number>();
      for (const item of body.items) {
        const id = String(item.product_id || "");
        const quantity = Number(item.quantity || 1);
        if (!/^[0-9a-f-]{36}$/i.test(id) || !Number.isInteger(quantity) || quantity < 1 || quantity > 5) return fail("Invalid cart item.");
        quantities.set(id, (quantities.get(id) || 0) + quantity);
      }
      const user = await getUser(req);
      if (user?.email && email !== user.email.toLowerCase()) return fail("Use the email address on your signed-in account.");
      const { data: accounts, error: accErr } = await admin.from("payment_bank_accounts")
        .select("id,bank_name,account_name,account_number,currency,instructions_en,instructions_ar")
        .eq("is_verified", true).eq("is_active", true).eq("currency", "NGN");
      if (accErr) throw accErr;
      const usableAccounts = (accounts || []).filter(a => method === "opay" ? /opay/i.test(a.bank_name) : !/opay/i.test(a.bank_name));
      if (!usableAccounts.length) return json({ error: "This payment option is not active yet. Please contact the marketplace administrator.", code: "PAYMENT_NOT_CONFIGURED" }, 409);
      const ids = [...quantities.keys()];
      const { data: products, error: prodErr } = await admin.from("products")
        .select("id,title_en,title_ar,price_ngn,is_published").in("id", ids).eq("is_published", true);
      if (prodErr) throw prodErr;
      if (!products || products.length !== ids.length) return fail("One or more products are no longer available. Refresh your cart.");
      const byId = new Map(products.map(p => [p.id, p]));
      const lines = ids.map(id => ({ product_id: id, quantity: quantities.get(id)!, unit_price: Number(byId.get(id)!.price_ngn) }));
      const total = lines.reduce((sum, line) => sum + line.unit_price * line.quantity, 0);
      if (!Number.isFinite(total) || total <= 0 || total > 10000000) return fail("Invalid order total.");
      const reference = newReference();
      const guestToken = user ? null : randomToken();
      const orderRow = {
        user_id: user?.id ?? null,
        buyer_email: email,
        guest_access_token_hash: guestToken ? await sha256(guestToken) : null,
        reference, gateway: method, currency: "NGN", amount_paid: total, status: "pending",
      };
      const { data: order, error: orderErr } = await admin.from("orders").insert(orderRow).select("id,reference,amount_paid,status,buyer_email").single();
      if (orderErr) throw orderErr;
      const { error: itemsErr } = await admin.from("order_items").insert(lines.map(l => ({ order_id: order.id, product_id: l.product_id, unit_price: l.unit_price, quantity: l.quantity })));
      if (itemsErr) {
        await admin.from("orders").delete().eq("id", order.id);
        throw itemsErr;
      }
      const { error: refErr } = await admin.from("payment_references").insert({
        order_id: order.id, reference, method, status: "issued",
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });
      if (refErr) {
        await admin.from("orders").delete().eq("id", order.id);
        throw refErr;
      }
      await notifyAdmins(order.id, "New order awaiting payment", `Order ${order.reference} was created for ${email}. It is waiting for payment.`);
      return json({ order, items: lines.map(l => ({ ...l, title: byId.get(l.product_id)!.title_en })), payment_accounts: usableAccounts, guest_access_token: guestToken });
    }

    if (action === "submit_payment") {
      const orderId = String(body.order_id || "");
      const method = body.method === "opay" ? "opay" : "bank_transfer";
      const payerName = String(body.payer_name || "").trim().slice(0, 100);
      const payerBank = String(body.payer_bank || "").trim().slice(0, 100);
      const transferRef = String(body.transfer_reference || "").trim().slice(0, 120);
      if (!orderId || payerName.length < 2 || transferRef.length < 4) return fail("Enter the sender name and bank transaction reference.");
      const user = await getUser(req);
      const guestToken = String(body.guest_access_token || "");
      const { data: order, error: orderErr } = await admin.from("orders").select("id,user_id,buyer_email,guest_access_token_hash,reference,gateway,currency,amount_paid,status").eq("id", orderId).maybeSingle();
      if (orderErr || !order) return fail("Order not found.", 404);
      if (order.user_id) {
        if (!user || user.id !== order.user_id) return fail("Sign in with the account used for this order.", 403);
      } else if (!guestToken || !order.guest_access_token_hash || await sha256(guestToken) !== order.guest_access_token_hash) {
        return fail("Order access code is incorrect.", 403);
      }
      if (order.status !== "pending" || order.gateway !== method) return fail("This order cannot accept this payment submission.", 409);
      const { data: paymentRef } = await admin.from("payment_references").select("id,status,expires_at,method").eq("order_id", order.id).maybeSingle();
      if (!paymentRef || paymentRef.status !== "issued" || new Date(paymentRef.expires_at).getTime() < Date.now() || paymentRef.method !== method) return fail("The payment reference has expired. Please create a new order.", 409);
      const { data: existing } = await admin.from("payments").select("id").eq("order_id", order.id).eq("status", "awaiting_review").limit(1);
      if (existing?.length) return fail("A payment submission is already awaiting review.", 409);
      const { data: accounts } = await admin.from("payment_bank_accounts").select("id,bank_name").eq("is_verified", true).eq("is_active", true).eq("currency", "NGN");
      if (!(accounts || []).some(a => method === "opay" ? /opay/i.test(a.bank_name) : !/opay/i.test(a.bank_name))) return fail("This payment option is currently unavailable.", 409);
      const { error: payErr } = await admin.from("payments").insert({
        order_id: order.id, method, amount: order.amount_paid, currency: "NGN",
        status: "awaiting_review", payer_name: payerName, payer_bank: payerBank || null,
        provider_transaction_id: transferRef,
        narration: String(body.narration || "").trim().slice(0, 300),
        provider_payload: { customer_submitted: true, order_reference: order.reference },
      });
      if (payErr) throw payErr;
      const { error: updateErr } = await admin.from("orders").update({ status: "awaiting_review" }).eq("id", order.id).eq("status", "pending");
      if (updateErr) throw updateErr;
      await notifyAdmins(order.id, "Payment submitted for verification", `Order ${order.reference} has a payment submission from ${payerName}. Please verify the transfer in your bank or wallet.`);
      return json({ ok: true, reference: order.reference, status: "awaiting_review", message: "Payment details submitted. Your order will be available after the administrator confirms the transfer." });
    }

    if (action === "guest_download") {
      const orderId = String(body.order_id || "");
      const token = String(body.guest_access_token || "");
      if (!orderId || !token) return fail("Order reference and access code are required.");
      const { data: order } = await admin.from("orders").select("id,status,guest_access_token_hash").eq("id", orderId).maybeSingle();
      if (!order || order.status !== "paid" || !order.guest_access_token_hash || await sha256(token) !== order.guest_access_token_hash) return fail("Order is not paid or access code is invalid.", 403);
      const { data: items, error: itemErr } = await admin.from("order_items").select("product_id").eq("order_id", orderId);
      if (itemErr) throw itemErr;
      const ids = [...new Set((items || []).map(i => i.product_id))];
      const { data: files, error: fileErr } = await admin.from("product_files").select("id,product_id,file_name,storage_path").in("product_id", ids);
      if (fileErr) throw fileErr;
      const downloads = [];
      for (const file of files || []) {
        const { data, error } = await admin.storage.from("digital-assets").createSignedUrl(file.storage_path, 90);
        if (!error && data?.signedUrl) downloads.push({ file_name: file.file_name, url: data.signedUrl, expires_in_seconds: 90 });
      }
      return json({ downloads });
    }

    if (action === "my_downloads") {
      const user = await getUser(req);
      if (!user) return fail("Please sign in to view your purchases.", 401);
      const { data: orders, error: ordersErr } = await admin.from("orders").select("id,reference,status,created_at,order_items(product_id,products(title_en,title_ar))").eq("user_id", user.id).eq("status", "paid").order("created_at", { ascending: false });
      if (ordersErr) throw ordersErr;
      const ids = [...new Set((orders || []).flatMap(o => (o.order_items || []).map((i: any) => i.product_id)))];
      const { data: files, error: fileErr } = await admin.from("product_files").select("id,product_id,file_name,storage_path").in("product_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
      if (fileErr) throw fileErr;
      const result = [];
      for (const file of files || []) {
        const { data, error } = await admin.storage.from("digital-assets").createSignedUrl(file.storage_path, 90);
        if (!error && data?.signedUrl) result.push({ file_name: file.file_name, url: data.signedUrl, expires_in_seconds: 90 });
      }
      return json({ downloads: result, orders });
    }

    if (action === "admin_notifications") {
      const user = await requireAdmin(req);
      const { data, error } = await admin.from("notifications").select("id,order_id,title,body,status,created_at,read_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      return json({ notifications: data || [] });
    }

    if (action === "admin_mark_notification_read") {
      const user = await requireAdmin(req);
      const notificationId = String(body.notification_id || "");
      if (!notificationId) return fail("Notification ID required.");
      const { error } = await admin.from("notifications").update({ status: "read", read_at: new Date().toISOString() }).eq("id", notificationId).eq("user_id", user.id);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "admin_list_admins") {
      await requireSuperAdmin(req);
      const { data, error } = await admin.from("profiles").select("id,email,full_name,role,created_at").in("role", ["admin", "super_admin"]).order("created_at", { ascending: true });
      if (error) throw error;
      return json({ admins: data || [] });
    }

    if (action === "admin_add_admin") {
      await requireSuperAdmin(req);
      const email = String(body.email || "").trim().toLowerCase();
      if (!email || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) return fail("Enter a valid email address.");
      const { data: target, error: findError } = await admin.from("profiles").select("id,email,role").eq("email", email).maybeSingle();
      if (findError) throw findError;
      if (!target) return fail("This person must create a customer account on Ilmora before you can make them an admin.");
      if (target.role === "super_admin") return fail("The owner account cannot be changed here.");
      if (target.role === "admin") return fail("This person is already an administrator.");
      const { data, error } = await admin.from("profiles").update({ role: "admin" }).eq("id", target.id).select("id,email,full_name,role").single();
      if (error) throw error;
      return json({ admin: data });
    }

    if (action === "admin_remove_admin") {
      const actor = await requireSuperAdmin(req);
      const targetId = String(body.user_id || "");
      if (!targetId) return fail("Administrator user ID required.");
      if (targetId === actor.id) return fail("You cannot remove your own owner access.");
      const { data: target, error: findError } = await admin.from("profiles").select("id,role").eq("id", targetId).maybeSingle();
      if (findError) throw findError;
      if (!target || target.role !== "admin") return fail("Only additional administrators can be removed here.");
      const { error } = await admin.from("profiles").update({ role: "customer" }).eq("id", targetId);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "admin_payments") {
      await requireAdmin(req);
      const { data, error } = await admin.from("payments").select("id,order_id,method,provider_transaction_id,amount,currency,status,payer_name,payer_bank,narration,created_at,orders(reference,buyer_email,gateway,status)").eq("status", "awaiting_review").order("created_at", { ascending: true });
      if (error) throw error;
      return json({ payments: data || [] });
    }

    if (action === "admin_review_payment") {
      const user = await requireAdmin(req);
      const paymentId = String(body.payment_id || "");
      if (!paymentId) return fail("Payment ID required.");
      const { error } = await admin.rpc("ilmora_admin_review_payment", {
        p_payment_id: paymentId, p_actor_id: user.id, p_approve: body.approve === true,
      });
      if (error) throw error;
      return json({ ok: true, status: body.approve === true ? "paid" : "rejected" });
    }

    if (action === "admin_accounts") {
      await requireAdmin(req);
      const { data, error } = await admin.from("payment_bank_accounts").select("id,bank_name,account_name,account_number,currency,is_verified,is_active,created_at").order("created_at");
      if (error) throw error;
      return json({ accounts: data || [] });
    }

    if (action === "admin_activate_account") {
      const user = await requireAdmin(req);
      const accountId = String(body.account_id || "");
      const activate = body.activate === true;
      const { data, error } = await admin.from("payment_bank_accounts").update({
        is_verified: activate, is_active: activate,
        verified_at: activate ? new Date().toISOString() : null,
        verified_by: activate ? user.id : null,
        updated_at: new Date().toISOString(),
      }).eq("id", accountId).select("id,is_active,is_verified").single();
      if (error) throw error;
      return json({ account: data });
    }

    return fail("Unknown action.", 404);
  } catch (error) {
    console.error("Ilmora commerce error:", error);
    return fail(error instanceof Error ? error.message : "Unexpected server error.", 400);
  }
});
