# Glemmekassen – regler for den som endrer koden

Glemmekassen er en mobil nettside: den som finner en gjenglemt gjenstand skanner telefonnummeret på navnelappen, og eieren får en SMS med bilde og kart.
Den vedlikeholdes av et lite team uten utviklerbakgrunn, med hjelp fra AI. Hold alt enkelt, og forklar endringer på vanlig norsk.

## Slik henger det sammen

| Del | Hva | Hvor |
|---|---|---|
| Appen | `hittegods.html` (`index.html` sender videre hit) | GitHub Pages, heiditha.github.io/Glemmekassen |
| Eiersiden | `eier.html?id=…` – lenken i SMS-en | GitHub Pages |
| Gammel bildeside | `bilde.html` – bare for eldre SMS-lenker | GitHub Pages |
| Bilder | Supabase Storage, bøtta `bilder` | Supabase-prosjekt `jyajkriknplrhsxustpf` |
| Funn bak eierlenken | tabellen `glemmekassen_shortlink_test` | Supabase |
| Global teller | tabellen `counter` + funksjonen `increment_counter` | Supabase |
| SMS | serverfunksjonen `glemmekassen-sms` → Sveve | `supabase/functions/glemmekassen-sms` |
| Lese nummer / gjenkjenne gjenstand | serverfunksjonen `claude-proxy` → Anthropic | `supabase/functions/claude-proxy` |

## Faste regler

1. **Aldri nøkler eller passord i HTML-filene.** Alt i HTML er offentlig. Hemmeligheter (Sveve, Anthropic, service-nøkkel) ligger bare som *secrets* i Supabase. Den eneste nøkkelen i HTML er Supabase sin offentlige `anon`-nøkkel, og den er laget for å være offentlig.
2. **Ikke lag kopier av sider** (`hittegods (2).html`, `..._TEST.html`, `backup/`). Alt som ligger i repoet er en offentlig side. Endre `hittegods.html` direkte – GitHub tar vare på alle gamle versjoner.
3. **SMS-teksten bestemmes på serveren**, i `smsText()` i `supabase/functions/glemmekassen-sms/index.ts`. `buildSmsText()` i `hittegods.html` er bare forhåndsvisningen – endre begge hvis teksten skal endres.
4. **Instruksjonene til Claude ligger på serveren**, i `PROMPTS` i `supabase/functions/claude-proxy/index.ts`. Appen sender bare navnet på oppgaven (`ocr`, `live_ocr`, `item`). Nye oppgaver må legges til der.
5. **Tekst fra brukere eller lenker settes inn med `textContent`, aldri `innerHTML`.**
6. **Bilder lastes opp uten `x-upsert`** og med tilfeldig navn (`crypto.randomUUID()`). Bøtta tillater ikke listing.
7. **Ikke lagre telefonnummeret** – heller ikke som «hash». Personvernteksten nederst i `hittegods.html` må stemme med det koden faktisk gjør.

## Grenser og opprydding

- Maks 100 SMS totalt per døgn (`MAX_SMS_PER_DAY`), og maks 5 per minutt / 50 per døgn per IP.
- Bilder og funn slettes automatisk etter 365 dager (`KEEP_DAYS`). Oppryddingen kjøres hver gang en SMS sendes.
- Bare norske mobilnummer (8 siffer, starter med 4 eller 9).

## Endre en serverfunksjon

Krever Supabase CLI og innlogging (`supabase login`). Fra repo-mappen:

```bash
supabase functions deploy glemmekassen-sms --project-ref jyajkriknplrhsxustpf --use-api --no-verify-jwt
```

Test etterpå med eget telefonnummer. Funksjonen må ha `--no-verify-jwt`, ellers slutter appen å virke.

## Teste

- Nettsiden oppdateres ca. ett minutt etter at endringer er lagt på `main` i GitHub.
- Test hele flyten på mobil: skann navnelapp → bilde → sted → send → åpne lenken i SMS-en.
- Send bare test-SMS til eget nummer.
