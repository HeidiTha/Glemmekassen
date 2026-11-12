// Glemmekassen: sender SMS til eieren og lagrer funnet bak en kort kode.
// POST {action:"sms"}: send SMS.  POST {action:"hentet"}: eieren har hentet tingen.
// POST {action:"status", ider:[…]}: hvor mange av finnerens funn som er hentet (telleren i appen).
// GET ?kode=BTKS (eldre: 482915 og K7M4Q2): hent funnet til eiersiden.  GET ?id=: samme, for gamle SMS-lenker.
// SMS-teksten lages her på serveren – nettleseren sender bare korte, rensede felter,
// så ingen kan bruke tjenesten til å sende egne meldinger.

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST,OPTIONS,GET" };
const json = (x: unknown, s = 200) =>
  new Response(JSON.stringify(x), { status: s, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const TABLE = "glemmekassen_shortlink_test";
const BILDE_PREFIX = "https://jyajkriknplrhsxustpf.supabase.co/storage/v1/object/public/bilder/";
const ITEM_TYPES = ["jakke", "genser", "bukse", "sko", "sekk", "lue/skjerf", "sportsutstyr", "vannflaske", "annet"];

// Sikkerhetsnett: maks antall SMS totalt per døgn (alle brukere til sammen)
const MAX_SMS_PER_DAY = 100;
// Etter så mange dager slettes bilde, sted, kart og kode (se personvernteksten i hittegods.html).
// Raden blir liggende med bare statistikk: gjenstand, farge, kommune, bydel, created_at og hentet_at.
const KEEP_DAYS = 365;
// Så mange funn tømmes per runde (holder godt med maks 100 SMS per døgn)
const RYDD_PER_GANG = 200;

// Tømmer funn eldre enn KEEP_DAYS for alt som er personlig, og sletter bildet.
// Kjøres etter hver sendte SMS, så det trengs ingen egen tidsplan. Feil her skal aldri stoppe en SMS.
async function cleanupOld(url: string, h: Record<string, string>) {
  try {
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString();
    const gamle = await fetch(
      `${url}/rest/v1/${TABLE}?created_at=lt.${cutoff}&anonymisert_at=is.null&select=id,bilde_url&limit=${RYDD_PER_GANG}`,
      { headers: h },
    );
    if (gamle.ok) {
      const rader = (await gamle.json()) as { id: string; bilde_url: string | null }[];
      if (rader.length) {
        // 1) Slett bildene som hører til funnene
        const bilder = rader.map((r) => r.bilde_url).filter((b): b is string => !!b && b.startsWith(BILDE_PREFIX))
          .map((b) => decodeURIComponent(b.slice(BILDE_PREFIX.length).split("?")[0]));
        if (bilder.length) {
          await fetch(`${url}/storage/v1/object/bilder`, { method: "DELETE", headers: h, body: JSON.stringify({ prefixes: bilder }) });
        }
        // 2) Tøm de personlige feltene. Koden blir null: en unik indeks i Postgres tillater mange null,
        //    og alle oppslag krever anonymisert_at=is.null, så en gammel kode eller lenke finner ingenting.
        await fetch(`${url}/rest/v1/${TABLE}?id=in.(${rader.map((r) => r.id).join(",")})`, {
          method: "PATCH", headers: h,
          body: JSON.stringify({ kode: null, bilde_url: null, stedsnavn: null, lat: null, lng: null, anonymisert_at: new Date().toISOString() }),
        });
      }
    }
    // 3) Sikkerhetsnett: bilder som aldri ble koblet til et funn (f.eks. SMS-en ble ikke sendt)
    const list = await fetch(`${url}/storage/v1/object/list/bilder`, {
      method: "POST", headers: h,
      body: JSON.stringify({ prefix: "", limit: 100, sortBy: { column: "created_at", order: "asc" } }),
    });
    const old = ((await list.json()) as { name: string; created_at: string }[])
      .filter((o) => o.created_at && o.created_at < cutoff).map((o) => o.name);
    if (old.length) {
      await fetch(`${url}/storage/v1/object/bilder`, { method: "DELETE", headers: h, body: JSON.stringify({ prefixes: old }) });
    }
  } catch (_) { /* prøver igjen neste gang */ }
}

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

// Hvordan hver kategori skrives i SMS-en, så småordene blir riktig norsk.
// ord = «Noen har funnet …», den = «se bilde og hvor … ligger».
// MÅ HOLDES LIK SMS_ORD i hittegods.html (forhåndsvisningen).
const SMS_ORD: Record<string, { ord: string; den: string }> = {
  "jakke":        { ord: "en jakke",               den: "den" },
  "genser":       { ord: "en genser",              den: "den" },
  "bukse":        { ord: "en bukse",               den: "den" },
  "sko":          { ord: "et par sko",             den: "de" },
  "sekk":         { ord: "en sekk",                den: "den" },
  "lue/skjerf":   { ord: "en lue eller et skjerf", den: "den" },
  "sportsutstyr": { ord: "noe sportsutstyr",       den: "det" },
  "vannflaske":   { ord: "en vannflaske",          den: "den" },
  "annet":        { ord: "en gjenstand",           den: "den" },
};

// Bare tegn fra det vanlige SMS-alfabetet (GSM 7-bit). Ett tegn utenfor (f.eks. emoji, «» eller ’)
// gjør at hver SMS-del bare får plass til 67 tegn i stedet for 153 – og SMS-en blir dyrere.
// Brukes bare på stedet fra finneren. Den faste teksten under har bare slike tegn.
const GSM_TEGN = "@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà\n";
function gsm(tekst: string): string {
  return tekst
    .replace(/[\u2018\u2019\u00b4`]/g, "'").replace(/[\u201c\u201d\u00ab\u00bb]/g, '"').replace(/[\u2013\u2014]/g, "-")
    .split("").map((t) => GSM_TEGN.includes(t) ? t : t.normalize("NFD").replace(/[\u0300-\u036f]/g, ""))
    .filter((t) => t.length === 1 && GSM_TEGN.includes(t)).join("")
    .replace(/\s+/g, " ").trim();
}

// SMS-teksten. Ingen emoji eller spesialtegn: da får SMS-en plass til mer per del (billigere).
// Fargen er ikke med – «en jakke (blå)» leses dårlig, og eieren ser fargen på bildet.
function smsText(gjenstand: string, posisjon: string, kode: string): string {
  const o = SMS_ORD[gjenstand] || SMS_ORD["annet"];
  const hvor = gsm(posisjon) || "et sted i nærheten";
  const hvorMedPreposisjon = /^(på|i|ved|hos)\s/i.test(hvor) ? hvor : `på ${hvor}`;
  return `Hei! Noen har funnet ${o.ord} med ditt nummer på navnelappen ${hvorMedPreposisjon}.

Trykk her for å se bilde og hvor ${o.den} ligger: glemmekassen.com/k?${kode}

Alternativt gå inn på glemmekassen.com og skriv koden ${kode}.

Hilsen Heidi Thaulow og Nora Brath Ingerø i Glemmekassen`;
}

// Koden: 4 store bokstaver (f.eks. BTKS). Den står i lenken i SMS-en og er lett å taste.
// Uten I, L, O og Q, som lett forveksles med 1, 0 og hverandre: 22 bokstaver gir 234 256 koder.
const KODE_TEGN = "ABCDEFGHJKMNPRSTUVWXYZ";
const KODE_LENGDE = 4;
// Koder vi ikke vil sende til noen
const STYGGE_KODER = ["FUCK", "FAEN", "KUKK", "CUNT", "PUPP", "RUMP", "SEXY", "DRAP", "DREP", "NAZI"];
function nyKode(): string {
  // Trekker hver bokstav uten skjevhet: tall over største multiplum av 22 under 2^32 kastes
  const grense = Math.floor(4294967296 / KODE_TEGN.length) * KODE_TEGN.length;
  let kode = "";
  while (kode.length < KODE_LENGDE) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0];
    if (n < grense) kode += KODE_TEGN[n % KODE_TEGN.length];
  }
  return STYGGE_KODER.includes(kode) ? nyKode() : kode;
}
// Eldre SMS-er har koder med 6 siffer (482915) eller 6 bokstaver og tall uten 0/O og 1/I/L (K7M4Q2). De virker fortsatt.
const GAMMEL_KODE_TEGN = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
// Tåler små bokstaver, mellomrom og bindestrek fra eieren
function rensKode(value: unknown): string {
  const k = String(value ?? "").toUpperCase().replace(/[\s-]/g, "");
  if (new RegExp(`^[${KODE_TEGN}]{${KODE_LENGDE}}$`).test(k)) return k;
  if (/^[0-9]{6}$/.test(k)) return k;
  return new RegExp(`^[${GAMMEL_KODE_TEGN}]{6}$`).test(k) ? k : "";
}

// Grense for feil koder per IP, så ingen kan prøve seg fram til andres funn
const MAX_FEIL_KODER_PER_TIME = 10;
const feilKoder = new Map<string, number[]>();
function forMangeFeil(ip: string): boolean {
  const now = Date.now();
  const recent = (feilKoder.get(ip) || []).filter((t) => now - t < 3600000);
  feilKoder.set(ip, recent);
  return recent.length >= MAX_FEIL_KODER_PER_TIME;
}
function registrerFeil(ip: string) {
  feilKoder.set(ip, [...(feilKoder.get(ip) || []), Date.now()]);
}

// Telleren spør om maks så mange funn om gangen
const MAX_IDER_STATUS = 300;

const FELTER = "gjenstand,farge,stedsnavn,lat,lng,bilde_url,kode,created_at,hentet_at";

const hits = new Map<string, number[]>();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const url = Deno.env.get("APP_URL"), key = Deno.env.get("APP_SERVICE_KEY");
    if (!url || !key) return json({ error: "Database ikke konfigurert" }, 500);
    const h = { "apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json" };

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";

    if (req.method === "GET") {
      const params = new URL(req.url).searchParams;
      let filter = "";
      if (params.has("kode")) {
        if (forMangeFeil(ip)) return json({ error: "For mange feil koder. Vent litt og prøv igjen." }, 429);
        const kode = rensKode(params.get("kode"));
        if (!kode) { registrerFeil(ip); return json({ error: "Koden har 4 bokstaver, f.eks. BTKS" }, 400); }
        filter = `kode=eq.${kode}`;
      } else {
        // Gamle SMS-er hadde lenke med id
        const id = params.get("id");
        if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Ugyldig lenke" }, 400);
        filter = `id=eq.${encodeURIComponent(id)}`;
      }
      // Funn eldre enn KEEP_DAYS er tømt og skal ikke kunne åpnes
      const r = await fetch(`${url}/rest/v1/${TABLE}?${filter}&anonymisert_at=is.null&select=${FELTER}`, { headers: h });
      if (!r.ok) return json({ error: "Kunne ikke hente gjenstand" }, 502);
      const data = await r.json();
      if (!data.length) {
        if (params.has("kode")) registrerFeil(ip);
        return json({ error: "Fant ingen funn med den koden. Sjekk at du har skrevet den riktig." }, 404);
      }
      return json({ item: data[0] });
    }
    if (req.method !== "POST") return json({ error: "Ugyldig metode" }, 405);

    const body = await req.json();

    // Eieren trykker «Jeg har hentet den». Den som kan koden (eller den gamle lenken) kan markere.
    if (body.action === "hentet") {
      if (forMangeFeil(ip)) return json({ error: "For mange feil koder. Vent litt og prøv igjen." }, 429);
      const kode = rensKode(body.kode);
      const id = typeof body.id === "string" && /^[0-9a-f-]{36}$/i.test(body.id) ? body.id : "";
      if (!kode && !id) return json({ error: "Mangler kode" }, 400);
      const filter = kode ? `kode=eq.${kode}` : `id=eq.${encodeURIComponent(id)}`;
      const r = await fetch(`${url}/rest/v1/${TABLE}?${filter}&hentet_at=is.null&anonymisert_at=is.null`, {
        method: "PATCH", headers: { ...h, Prefer: "return=representation" },
        body: JSON.stringify({ hentet_at: new Date().toISOString() }),
      });
      if (!r.ok) return json({ error: "Kunne ikke lagre at den er hentet" }, 502);
      // Ingen treff: enten feil kode (teller som feil) eller allerede markert som hentet (helt greit)
      if (!(await r.json()).length && kode) {
        const finnes = await fetch(`${url}/rest/v1/${TABLE}?kode=eq.${kode}&anonymisert_at=is.null&select=kode`, { headers: h });
        if (!(await finnes.json()).length) { registrerFeil(ip); return json({ error: "Fant ingen funn med den koden" }, 404); }
      }
      return json({ ok: true });
    }
    // Telleren: appen sender id-ene til funnene den har registrert, og får bare tilbake ett tall.
    // Id-ene er lange og tilfeldige, så ingen kan gjette seg fram til andres funn.
    if (body.action === "status") {
      const ider = (Array.isArray(body.ider) ? body.ider : [])
        .filter((x: unknown) => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)).slice(-MAX_IDER_STATUS);
      if (!ider.length) return json({ hentet: 0 });
      const r = await fetch(`${url}/rest/v1/${TABLE}?id=in.(${ider.join(",")})&hentet_at=not.is.null&select=id`, { headers: h });
      if (!r.ok) return json({ error: "Kunne ikke hente status" }, 502);
      return json({ hentet: (await r.json()).length });
    }
    if (body.action !== "sms") return json({ error: "Ugyldig handling" }, 400);

    // Grense per IP (nullstilles når funksjonen starter på nytt, derfor også et tak under)
    const now = Date.now(), recent = (hits.get(ip) || []).filter((t) => now - t < 86400000);
    if (recent.filter((t) => now - t < 60000).length >= 5 || recent.length >= 50) return json({ error: "For mange SMS-forsøk" }, 429);
    recent.push(now); hits.set(ip, recent);

    // Totalt tak per døgn, talt i databasen (hver SMS lagrer ett funn)
    const since = new Date(now - 86400000).toISOString();
    const countRes = await fetch(`${url}/rest/v1/${TABLE}?select=id&created_at=gte.${since}`, {
      method: "HEAD", headers: { ...h, Prefer: "count=exact" },
    });
    const sentToday = Number(countRes.headers.get("content-range")?.split("/")[1] ?? NaN);
    if (!Number.isFinite(sentToday)) return json({ error: "Kunne ikke sjekke SMS-grensen" }, 502);
    if (sentToday >= MAX_SMS_PER_DAY) return json({ error: "Glemmekassen har nådd dagens SMS-grense. Prøv igjen i morgen." }, 429);

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
    // Kommune og bydel (fra appens adresseoppslag) – beholdes til statistikk etter KEEP_DAYS
    const kommune = clean(body.kommune, 40);
    const bydel = clean(body.bydel, 40);

    const record = {
      gjenstand,
      farge: farge || null,
      kommune: kommune || null,
      bydel: bydel || null,
      stedsnavn: [posisjon, sted].filter(Boolean).join(" – ") || null,
      lat: okPos ? lat : null,
      lng: okPos ? lng : null,
      bilde_url: bildeUrl,
    };
    // Lag en kode som ikke er brukt av et aktivt funn. Tømte funn (anonymisert_at) har ikke kode lenger.
    // Den unike indeksen glemmekassen_kode_unik er sikkerhetsnettet hvis to SMS-er får samme kode samtidig (409).
    let kode = "", id = "";
    for (let forsok = 0; forsok < 10 && !kode; forsok++) {
      const prov = nyKode();
      const iBruk = await fetch(`${url}/rest/v1/${TABLE}?kode=eq.${prov}&anonymisert_at=is.null&select=id`, { headers: h });
      if (!iBruk.ok) return json({ error: "Kunne ikke lage kode" }, 502);
      if ((await iBruk.json()).length) continue;
      const saved = await fetch(`${url}/rest/v1/${TABLE}`, {
        method: "POST", headers: { ...h, Prefer: "return=representation" }, body: JSON.stringify({ ...record, kode: prov }),
      });
      if (saved.ok) { kode = prov; id = (await saved.json())[0]?.id || ""; }
      else if (saved.status !== 409) return json({ error: "Kunne ikke lagre gjenstanden" }, 502);
    }
    if (!kode) return json({ error: "Kunne ikke lage kode" }, 502);

    const msg = smsText(gjenstand, posisjon, kode);
    const sms = await fetch("https://sveve.no/SMS/SendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Avsendernavn kan være maks 11 tegn hos Sveve
      body: JSON.stringify({ user: sveveUser, passwd: svevePass, to, from: "GlemmeKasse", msg }),
    });
    const txt = await sms.text();
    if (!sms.ok || txt.startsWith("+++")) return json({ error: "SMS-feil: " + txt.slice(0, 180) }, 502);
    await cleanupOld(url, h);
    // id lagres i finnerens telefon, så telleren kan vise hvor mange som har kommet hjem
    return json({ ok: true, kode, id });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
