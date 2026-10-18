// Glemmekassen: bildegjenkjenning (Claude) og global teller.
// SMS sendes IKKE herfra lenger – se glemmekassen-sms.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// Faste instruksjoner. Nettleseren velger bare hvilken oppgave, aldri selve teksten,
// så ingen kan bruke Anthropic-kontoen til andre formål.
const PROMPTS: Record<string, string> = {
  live_ocr:
    'Read the Norwegian phone number on the clothing name label in this image. Return ONLY JSON: {"phone":"91234567"}. If not clearly readable, return {"phone":""}. Do not guess.',
  ocr:
    'This is a photo of a name tag or clothing label. Extract the phone number. It may include a +47 or 47 country code prefix — include it as-is. Return ONLY JSON: {"phone": "91234567", "name": "Ola"} — digits and optional +47 prefix only, name only if clearly visible. If no number found: {"phone": "", "name": ""}. No other text.',
  item:
    'This is a lost & found item. What type and color is it? Return ONLY a JSON object: {"type": "jakke", "color": "rød"} — type must be one of: jakke, genser, bukse, sko, sekk, lue/skjerf, sportsutstyr, annet. Color: short Norwegian description e.g. rød, mørkeblå, svart/hvit. No other text.',
};
const MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMAGE_BASE64 = 8_000_000; // ca. 6 MB bilde

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const body = await req.json();

    // ── Global teller ─────────────────────────────────────
    if (body.action === "increment_counter") {
      const supabaseUrl = Deno.env.get("APP_URL");
      const supabaseKey = Deno.env.get("APP_SERVICE_KEY");
      if (!supabaseUrl || !supabaseKey) return json({ count: 0 });
      const res = await fetch(`${supabaseUrl}/rest/v1/rpc/increment_counter`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` },
        body: JSON.stringify({}),
      });
      return json({ count: await res.json() });
    }

    if (body.action === "sms") return json({ error: "SMS sendes nå via glemmekassen-sms" }, 410);

    // ── Claude: kun kjente oppgaver ───────────────────────
    const prompt = PROMPTS[body.task];
    if (!prompt) return json({ error: "Ukjent oppgave" }, 400);
    const { image, mediaType } = body;
    if (typeof image !== "string" || !image || image.length > MAX_IMAGE_BASE64) return json({ error: "Ugyldig bilde" }, 400);
    if (!MEDIA_TYPES.includes(mediaType)) return json({ error: "Ugyldig bildetype" }, 400);

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicKey) return json({ error: "API-nøkkel ikke konfigurert" }, 500);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });
    const data = await response.json();
    return json({ text: data.content?.[0]?.text || "" });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
