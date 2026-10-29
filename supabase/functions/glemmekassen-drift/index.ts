// Glemmekassen: tall til driftssiden (glemmekassen.com/drift). Bare for teamet.
// POST {action:"login", passord}  → { billett }   (billetten varer i 30 dager)
// POST {action:"tall", billett}    → { tall }      (bare opptelte tall – ingen persondata)
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
  const funn = await hentFunn(url, h, new Date(na - 60 * dag).toISOString());
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

  return {
    oppdatert: new Date(na).toISOString(),
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
    return json({ error: "Ugyldig handling" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
