// Glemmekassen: tall til driftssiden (glemmekassen.com/drift). Bare for teamet.
// POST {action:"login", passord}  → { billett }   (billetten varer i 30 dager)
// POST {action:"tall", billett}    → { tall }      (bare opptelte tall – ingen persondata)
// POST {action:"ny_kostnad", billett, dato, hva, type, belop} → legger inn en kostnad eller inntekt (fanen «Kostnader»)
// POST {action:"slett_kostnad", billett, id}                  → sletter en kostnad eller inntekt
// Tabellene (okonomi og sms_per_maaned) lages med supabase/sql/kostnader.sql.
// Secrets i Supabase: DRIFT_PASSORD (teampassordet) og DRIFT_NOKKEL (lang tilfeldig tekst som signerer billetten).
// Bytter dere DRIFT_NOKKEL, blir alle logget ut. Bytter dere DRIFT_PASSORD, virker gamle billetter til de går ut.

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST,OPTIONS" };
const json = (x: unknown, s = 200) =>
  new Response(JSON.stringify(x), { status: s, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const TABLE = "glemmekassen_shortlink_test";
// MÅ HOLDES LIK grensene i glemmekassen-sms (MAX_SMS_PER_DAY) og claude-proxy (MAX_AI_CALLS_PER_DAY)
const MAX_SMS_PER_DAY = 100;
const MAX_AI_CALLS_PER_DAY = 500;
const BILLETT_DAGER = 30;
// Løpende kostnad per SMS som sendes (kroner). Endre her hvis prisene endrer seg.
const PRIS_SVEVE_PER_SMS = 0.6;   // Sveve, SMS-en
const PRIS_CLAUDE_PER_SMS = 2.0;  // Claude, lesing av nummer og gjenstand
const KOSTNAD_TYPER = ["claude", "trykk", "domene", "annet"];
const INNTEKT_TYPER = ["gave", "sponsor", "stotte", "annen_inntekt"];
// Grense for feil passord per IP
const MAX_FEIL_PASSORD = 5;
const FEIL_VINDU_MS = 15 * 60000;

const feil = new Map<string, number[]>();
const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hmac(nokkel: string, tekst: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(nokkel), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(tekst))));
}
// Sammenligner uten å avsløre hvor mange tegn som stemte
function likt(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}
async function lagBillett(nokkel: string): Promise<string> {
  const utloper = String(Date.now() + BILLETT_DAGER * 86400000);
  return `${utloper}.${await hmac(nokkel, utloper)}`;
}
async function gyldigBillett(nokkel: string, billett: unknown): Promise<boolean> {
  const [utloper, sig] = String(billett ?? "").split(".");
  if (!utloper || !sig || !/^\d+$/.test(utloper) || Number(utloper) < Date.now()) return false;
  return likt(sig, await hmac(nokkel, utloper));
}

// Dato i norsk tid, f.eks. «2026-10-28»
const osloDag = (d: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(d);

type Funn = { created_at: string; hentet_at: string | null; gjenstand: string | null };

// Henter alle funn siden en dato, 1000 om gangen (databasen gir maks 1000 per kall)
async function hentFunn(url: string, h: Record<string, string>, siden: string): Promise<Funn[]> {
  const alle: Funn[] = [];
  for (let fra = 0; fra < 50000; fra += 1000) {
    const r = await fetch(`${url}/rest/v1/${TABLE}?select=created_at,hentet_at,gjenstand&created_at=gte.${siden}&order=created_at.asc`, {
      headers: { ...h, Range: `${fra}-${fra + 999}` },
    });
    if (!r.ok) throw new Error("Kunne ikke hente funn");
    const side = await r.json() as Funn[];
    alle.push(...side);
    if (side.length < 1000) break;
  }
  return alle;
}

async function regnUt(url: string, h: Record<string, string>) {
  const na = Date.now();
  const dag = 86400000;
  // Funn slettes etter 365 dager, så vi henter alt som finnes
  const funn = await hentFunn(url, h, new Date(na - 400 * dag).toISOString());
  const tid = (f: Funn) => Date.parse(f.created_at);
  const innen = (fra: number, til = 0) => funn.filter((f) => tid(f) >= na - fra * dag && tid(f) < na - til * dag);

  const siste30 = innen(30), forrige30 = innen(60, 30), siste7 = innen(7);
  const hjem30 = siste30.filter((f) => f.hentet_at).length;

  // Per dag siste 14 dager (norsk dato)
  const perDag: { dag: string; funn: number; hjem: number }[] = [];
  for (let i = 13; i >= 0; i--) perDag.push({ dag: osloDag(new Date(na - i * dag)), funn: 0, hjem: 0 });
  for (const f of innen(15)) {
    const rad = perDag.find((p) => p.dag === osloDag(new Date(tid(f))));
    if (rad) { rad.funn++; if (f.hentet_at) rad.hjem++; }
  }

  // Hva som blir funnet (siste 30 dager)
  const typer: Record<string, number> = {};
  for (const f of siste30) typer[f.gjenstand || "annet"] = (typer[f.gjenstand || "annet"] || 0) + 1;

  // Tid fra SMS til «Jeg har hentet den» (median, timer)
  const timer = siste30.filter((f) => f.hentet_at).map((f) => (Date.parse(f.hentet_at!) - tid(f)) / 3600000).filter((t) => t >= 0).sort((a, b) => a - b);
  const median = timer.length ? (timer.length % 2 ? timer[(timer.length - 1) / 2] : (timer[timer.length / 2 - 1] + timer[timer.length / 2]) / 2) : null;

  // Denne måneden (norsk tid)
  const maaned = osloDag(new Date(na)).slice(0, 7);
  const smsMaaned = funn.filter((f) => osloDag(new Date(tid(f))).startsWith(maaned)).length;

  // Kall til Claude: tabellen ai_bruk har én rad per døgn (databasens dato, UTC)
  const iDagUtc = new Date(na).toISOString().slice(0, 10);
  const ai = await fetch(`${url}/rest/v1/ai_bruk?select=dag,antall&dag=gte.${maaned}-01&order=dag.asc`, { headers: h });
  const aiRader = ai.ok ? await ai.json() as { dag: string; antall: number }[] : [];

  const kost = await kostnader(url, h, funn);

  return {
    oppdatert: new Date(na).toISOString(),
    kost,
    smsSiste24t: funn.filter((f) => tid(f) >= na - dag).length,
    maxSms: MAX_SMS_PER_DAY,
    aiIDag: aiRader.find((r) => r.dag === iDagUtc)?.antall ?? 0,
    maxAi: MAX_AI_CALLS_PER_DAY,
    funn7: siste7.length,
    funn30: siste30.length,
    funnForrige30: forrige30.length,
    hjem30,
    andelHjem: siste30.length ? Math.round((hjem30 / siste30.length) * 100) : null,
    medianTimerTilHentet: median === null ? null : Math.round(median * 10) / 10,
    perDag,
    typer,
    smsMaaned,
    aiMaaned: aiRader.reduce((s, r) => s + (r.antall || 0), 0),
    aiKjent: ai.ok,
  };
}

// Antall SMS (= funn) og antall som kom hjem, per måned. Tallene lagres i sms_per_maaned,
// og vi beholder alltid det høyeste tallet – så måneder eldre enn 365 dager blir stående.
async function kostnader(url: string, h: Record<string, string>, funn: Funn[]) {
  const talt: Record<string, { sms: number; hjem: number }> = {};
  for (const f of funn) {
    const m = osloDag(new Date(Date.parse(f.created_at))).slice(0, 7);
    talt[m] ||= { sms: 0, hjem: 0 };
    talt[m].sms++;
    if (f.hentet_at) talt[m].hjem++;
  }
  const lagret = await fetch(`${url}/rest/v1/sms_per_maaned?select=maaned,sms,hjem&order=maaned.asc`, { headers: h });
  if (!lagret.ok) {
    // Tabellene er ikke laget ennå (supabase/sql/kostnader.sql er ikke kjørt)
    return { kjent: false, prisSveve: PRIS_SVEVE_PER_SMS, prisClaude: PRIS_CLAUDE_PER_SMS, maaneder: [], poster: [] };
  }
  const svar = await lagret.json();
  const rader = (Array.isArray(svar) ? svar : []) as { maaned: string; sms: number; hjem: number }[];
  const alle: Record<string, { sms: number; hjem: number }> = {};
  for (const r of rader) alle[r.maaned] = { sms: r.sms, hjem: r.hjem };
  const oppdater: { maaned: string; sms: number; hjem: number }[] = [];
  for (const [m, t] of Object.entries(talt)) {
    const g = alle[m] || { sms: 0, hjem: 0 };
    const ny = { sms: Math.max(g.sms, t.sms), hjem: Math.max(g.hjem, t.hjem) };
    if (ny.sms !== g.sms || ny.hjem !== g.hjem) oppdater.push({ maaned: m, ...ny });
    alle[m] = ny;
  }
  if (oppdater.length) {
    await fetch(`${url}/rest/v1/sms_per_maaned?on_conflict=maaned`, {
      method: "POST", headers: { ...h, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(oppdater),
    });
  }
  const p = await fetch(`${url}/rest/v1/okonomi?select=id,dato,hva,type,belop&order=dato.desc,created_at.desc&limit=2000`, { headers: h });
  const poster = p.ok ? (await p.json() as { id: string; dato: string; hva: string; type: string; belop: number | string }[])
    .map((x) => ({ ...x, belop: Number(x.belop) })) : [];
  return {
    kjent: true,
    prisSveve: PRIS_SVEVE_PER_SMS,
    prisClaude: PRIS_CLAUDE_PER_SMS,
    maaneder: Object.entries(alle).sort(([a], [b]) => (a < b ? -1 : 1)).map(([maaned, t]) => ({ maaned, ...t })),
    poster,
  };
}

// Sjekker en ny kostnad fra skjemaet. Gir feilmelding som tekst, eller den rensede kostnaden.
function sjekkKostnad(b: Record<string, unknown>): string | { dato: string; hva: string; type: string; belop: number } {
  const dato = String(b.dato ?? "");
  const tid = Date.parse(dato + "T12:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dato) || isNaN(tid) || new Date(tid).toISOString().slice(0, 10) !== dato) return "Velg en dato";
  if (dato < "2024-01-01" || Date.parse(dato) > Date.now() + 366 * 86400000) return "Datoen ser feil ut";
  const hva = String(b.hva ?? "").trim().replace(/\s+/g, " ");
  if (!hva) return "Skriv hva kostnaden gjelder";
  if (hva.length > 80) return "Beskrivelsen kan ha maks 80 tegn";
  const type = String(b.type ?? "");
  if (!KOSTNAD_TYPER.includes(type) && !INNTEKT_TYPER.includes(type)) return "Velg type";
  const belop = Math.round(Number(String(b.belop ?? "").replace(/\s/g, "").replace(",", ".")) * 100) / 100;
  if (!Number.isFinite(belop) || belop <= 0) return "Skriv et beløp i kroner";
  if (belop > 1000000) return "Beløpet er for stort";
  return { dato, hva, type, belop };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "Ugyldig metode" }, 405);
  try {
    const url = Deno.env.get("APP_URL"), key = Deno.env.get("APP_SERVICE_KEY");
    const passord = Deno.env.get("DRIFT_PASSORD"), nokkel = Deno.env.get("DRIFT_NOKKEL");
    if (!url || !key) return json({ error: "Database ikke konfigurert" }, 500);
    if (!passord || !nokkel || nokkel.length < 32) return json({ error: "Driftssiden er ikke satt opp (DRIFT_PASSORD og DRIFT_NOKKEL mangler)" }, 500);
    const h = { "apikey": key, "Authorization": "Bearer " + key };
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";
    const body = await req.json().catch(() => ({}));

    if (body.action === "login") {
      const na = Date.now();
      const nylige = (feil.get(ip) || []).filter((t) => na - t < FEIL_VINDU_MS);
      if (nylige.length >= MAX_FEIL_PASSORD) return json({ error: "For mange feil forsøk. Vent 15 minutter." }, 429);
      if (!likt(String(body.passord ?? ""), passord)) {
        feil.set(ip, [...nylige, na]);
        return json({ error: "Feil passord" }, 401);
      }
      feil.delete(ip);
      return json({ billett: await lagBillett(nokkel) });
    }

    if (body.action === "tall") {
      if (!(await gyldigBillett(nokkel, body.billett))) return json({ error: "Logg inn på nytt" }, 401);
      return json({ tall: await regnUt(url, h) });
    }

    if (body.action === "ny_kostnad" || body.action === "slett_kostnad") {
      if (!(await gyldigBillett(nokkel, body.billett))) return json({ error: "Logg inn på nytt" }, 401);
      const hj = { ...h, "Content-Type": "application/json", Prefer: "return=minimal" };
      if (body.action === "ny_kostnad") {
        const k = sjekkKostnad(body);
        if (typeof k === "string") return json({ error: k }, 400);
        const r = await fetch(`${url}/rest/v1/okonomi`, { method: "POST", headers: hj, body: JSON.stringify(k) });
        if (!r.ok) return json({ error: "Kunne ikke lagre. Er supabase/sql/kostnader.sql kjørt?" }, 502);
        return json({ ok: true });
      }
      const id = String(body.id ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Ugyldig kostnad" }, 400);
      const r = await fetch(`${url}/rest/v1/okonomi?id=eq.${id}`, { method: "DELETE", headers: hj });
      if (!r.ok) return json({ error: "Kunne ikke slette" }, 502);
      return json({ ok: true });
    }
    return json({ error: "Ugyldig handling" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
