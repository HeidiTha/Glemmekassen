// Glemmekassen: sender SMS til eieren og lagrer funnet bak en kort lenke.
// POST: send SMS. GET ?id=: hent funnet til eiersiden.
// SMS-teksten lages her på serveren – nettleseren sender bare korte, rensede felter,
// så ingen kan bruke tjenesten til å sende egne meldinger.

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST,OPTIONS,GET" };
const json = (x: unknown, s = 200) =>
  new Response(JSON.stringify(x), { status: s, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const TABLE = "glemmekassen_shortlink_test";
const OWNER_PAGE = "https://heiditha.github.io/Glemmekassen/eier.html?id=";
const APP_LINK = "https://heiditha.github.io/Glemmekassen/hittegods.html";
const BILDE_PREFIX = "https://jyajkriknplrhsxustpf.supabase.co/storage/v1/object/public/bilder/";
const ITEM_TYPES = ["jakke", "genser", "bukse", "sko", "sekk", "lue/skjerf", "sportsutstyr", "vannflaske", "annet"];

// Kort, ren tekst: ingen linjeskift, lenker eller nettadresser
function clean(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/(https?:\/\/|www\.)\S*/gi, "")
    .replace(/\S+\.(no|com|net|org|io|ly|me|app|link|xyz|info|biz|co|se|dk|eu|tk|gl|gd|cc)\b\S*/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function smsText(farge: string, posisjon: string, lenke: string): string {
  const gjenstand = farge ? `gjenstand (${farge})` : "gjenstand";
  const sted = posisjon || "et sted i nærheten";
  const stedMedPreposisjon = /^(på|i|ved|hos)\s/i.test(sted) ? sted : `på ${sted}`;
  return `Hei! Noen fant en ${gjenstand} som kan være din ${stedMedPreposisjon}. 🧤

Se bilde og kart: ${lenke}

Hent den så fort du kan – jo raskere, desto bedre sjanse for at den fortsatt er der!

Fikk du den tilbake? Vipps gjerne 10 kr eller send en hilsen til 952 76 157. Helt frivillig.

Hilsen Glemmekassen 💛

Vil du hjelpe andre med å finne det de har mistet? Bruk Glemmekassen neste gang du finner noe!
${APP_LINK}`;
}

const hits = new Map<string, number[]>();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const url = Deno.env.get("APP_URL"), key = Deno.env.get("APP_SERVICE_KEY");
    if (!url || !key) return json({ error: "Database ikke konfigurert" }, 500);
    const h = { "apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json" };

    if (req.method === "GET") {
      const id = new URL(req.url).searchParams.get("id");
      if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Ugyldig lenke" }, 400);
      const r = await fetch(`${url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}&select=gjenstand,stedsnavn,lat,lng,bilde_url`, { headers: h });
      if (!r.ok) return json({ error: "Kunne ikke hente gjenstand" }, 502);
      const data = await r.json();
      return data.length ? json({ item: data[0] }) : json({ error: "Fant ikke gjenstanden" }, 404);
    }
    if (req.method !== "POST") return json({ error: "Ugyldig metode" }, 405);

    const body = await req.json();
    if (body.action !== "sms") return json({ error: "Ugyldig handling" }, 400);

    // Enkel grense per IP (en bedre, global grense kommer)
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";
    const now = Date.now(), recent = (hits.get(ip) || []).filter((t) => now - t < 86400000);
    if (recent.filter((t) => now - t < 60000).length >= 5 || recent.length >= 50) return json({ error: "For mange SMS-forsøk" }, 429);
    recent.push(now); hits.set(ip, recent);

    // Bare norske mobilnummer (8 siffer som starter med 4 eller 9)
    const to = String(body.to || "").replace(/\D/g, "").replace(/^(0047|47)(?=\d{8}$)/, "");
    if (!/^[49]\d{7}$/.test(to)) return json({ error: "Ugyldig telefonnummer" }, 400);

    const sveveUser = Deno.env.get("SVEVE_USER"), svevePass = Deno.env.get("SVEVE_PASS");
    if (!sveveUser || !svevePass) return json({ error: "SMS-tjenesten er ikke konfigurert" }, 500);

    const gjenstand = ITEM_TYPES.includes(body.gjenstand) ? body.gjenstand : "annet";
    const farge = clean(body.farge, 30);
    const posisjon = clean(body.posisjon, 80);
    const sted = clean(body.sted, 80);
    const lat = Number(body.lat), lng = Number(body.lng);
    const okPos = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && body.lat != null && body.lng != null;
    const bildeUrl = typeof body.bilde_url === "string" && body.bilde_url.startsWith(BILDE_PREFIX) ? body.bilde_url : null;

    const record = {
      gjenstand,
      stedsnavn: [sted, posisjon].filter(Boolean).join(" — ") || null,
      lat: okPos ? lat : null,
      lng: okPos ? lng : null,
      bilde_url: bildeUrl,
    };
    const saved = await fetch(`${url}/rest/v1/${TABLE}`, { method: "POST", headers: { ...h, Prefer: "return=representation" }, body: JSON.stringify(record) });
    if (!saved.ok) return json({ error: "Kunne ikke lagre gjenstanden" }, 502);
    const id = (await saved.json())[0]?.id;
    if (!id) return json({ error: "Mangler gjenstands-ID" }, 502);

    const msg = smsText(farge, posisjon, OWNER_PAGE + id);
    const sms = await fetch("https://sveve.no/SMS/SendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: sveveUser, passwd: svevePass, to, from: "Glemmekassen", msg }),
    });
    const txt = await sms.text();
    if (!sms.ok || txt.startsWith("+++")) return json({ error: "SMS-feil: " + txt.slice(0, 180) }, 502);
    return json({ ok: true, id });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
