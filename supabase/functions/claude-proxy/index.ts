// ── Rate limiting (in-memory, per IP) ─────────────────
const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const minuteMs = 60_000;
  const dayMs = 86_400_000;

  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, dayCount: entry?.dayCount ?? 0, resetAt: now + minuteMs, dayResetAt: entry?.dayResetAt ?? now + dayMs };
  }
  if (now > entry.dayResetAt) {
    entry.dayCount = 0;
    entry.dayResetAt = now + dayMs;
  }
  entry.count++;
  entry.dayCount++;
  rateLimitMap.set(ip, entry);

  if (entry.count > 5)     return { allowed: false, reason: "For mange SMS per minutt (maks 5)" };
  if (entry.dayCount > 50) return { allowed: false, reason: "For mange SMS per dag (maks 50)" };
  return { allowed: true };
}

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body = await req.json();

    // ── Sveve SMS ─────────────────────────────────────────
    if (body.action === "sms") {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
      const rl = checkRateLimit(ip);
      if (!rl.allowed) {
        return new Response(JSON.stringify({ error: rl.reason }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const sveveUser   = Deno.env.get("SVEVE_USER");
      const svevePass   = Deno.env.get("SVEVE_PASS");
      const supabaseUrl = Deno.env.get("APP_URL");
      const supabaseKey = Deno.env.get("APP_SERVICE_KEY");

      if (!sveveUser || !svevePass) {
        return new Response(
          JSON.stringify({ error: "Sveve ikke konfigurert" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      let finalMsg = body.msg;
      if (body.bilde_page_url) {
        let bildeUrl = body.bilde_page_url;
        try {
          const tinyRes = await fetch(
            `https://tinyurl.com/api-create.php?url=${encodeURIComponent(body.bilde_page_url)}`
          );
          if (tinyRes.ok) {
            const short = (await tinyRes.text()).trim();
            if (short.startsWith('https://tinyurl.com')) bildeUrl = short;
          }
        } catch(_) {}
        finalMsg = finalMsg.replace('__BILDE_URL__', bildeUrl);
      } else {
        finalMsg = finalMsg.replace(/\n📸 Se bilde: __BILDE_URL__/, '');
      }

      const toNumber = body.to.startsWith('+47')
        ? body.to.slice(3)
        : body.to.startsWith('+')
          ? body.to.slice(1)
          : body.to;

      const sveveRes = await fetch('https://sveve.no/SMS/SendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user: sveveUser,
          passwd: svevePass,
          to: toNumber,
          from: 'Glemmekassen',
          msg: finalMsg
        })
      });

      const sveveText = await sveveRes.text();

      if (sveveText.startsWith('+++')) {
        return new Response(JSON.stringify({ error: `Sveve feil: ${sveveText}` }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      if (supabaseUrl && supabaseKey) {
        const encoder = new TextEncoder();
        const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(body.to));
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const telefonHash = hashArray.map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);

        await fetch(`${supabaseUrl}/rest/v1/varsler`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": supabaseKey,
            "Authorization": `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({
            gjenstand:    body.gjenstand  || null,
            stedsnavn:    body.stedsnavn  || null,
            lat:          body.lat        || null,
            lng:          body.lng        || null,
            telefon_hash: telefonHash,
            bilde_url:    body.bilde_url  || null,
          }),
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // ── Increment counter ─────────────────────────────────
    if (body.action === "increment_counter") {
      const supabaseUrl = Deno.env.get("APP_URL");
      const supabaseKey = Deno.env.get("APP_SERVICE_KEY");
      if (supabaseUrl && supabaseKey) {
        const res = await fetch(`${supabaseUrl}/rest/v1/rpc/increment_counter`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": supabaseKey,
            "Authorization": `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({}),
        });
        const count = await res.json();
        return new Response(JSON.stringify({ count }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ count: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // ── Claude OCR ─────────────────────────────────────────
    const { image, mediaType, prompt } = body;
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicKey) {
      return new Response(
        JSON.stringify({ error: "API-nøkkel ikke konfigurert" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
            { type: "text", text: prompt }
          ]
        }]
      }),
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || "";
    return new Response(
      JSON.stringify({ text }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (e) {
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
