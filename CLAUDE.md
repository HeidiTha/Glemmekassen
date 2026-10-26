# Glemmekassen – regler for den som endrer koden

Glemmekassen er en mobil nettside: den som finner en gjenglemt gjenstand tar bilde av telefonnummeret på navnelappen, og eieren får en SMS med bilde og kart.
Den vedlikeholdes av et lite team uten utviklerbakgrunn, med hjelp fra AI. Hold alt enkelt, og forklar endringer på vanlig norsk.

## Slik henger det sammen

| Del | Hva | Hvor |
|---|---|---|
| Appen | `hittegods.html` (`index.html` sender videre hit) | glemmekassen.com (GitHub Pages, domenet ligger i `CNAME`) |
| Eiersiden | `eier.html?id=…` – lenken i SMS-en | glemmekassen.com/eier.html |
| Gammel bildeside | `bilde.html` – bare for eldre SMS-lenker | glemmekassen.com/bilde.html |
| Bilder | Supabase Storage, bøtta `bilder` | Supabase-prosjekt `jyajkriknplrhsxustpf` |
| Funn bak eierlenken | tabellen `glemmekassen_shortlink_test` | Supabase |
| Global teller | tabellen `counter` + funksjonen `increment_counter` | Supabase |
| SMS | serverfunksjonen `glemmekassen-sms` → Sveve | `supabase/functions/glemmekassen-sms` |
| Lese nummer / gjenkjenne gjenstand | serverfunksjonen `claude-proxy` → Anthropic | `supabase/functions/claude-proxy` |

## Faste regler

1. **Aldri nøkler eller passord i HTML-filene.** Alt i HTML er offentlig. Hemmeligheter (Sveve, Anthropic, service-nøkkel) ligger bare som *secrets* i Supabase. Den eneste nøkkelen i HTML er Supabase sin offentlige `anon`-nøkkel, og den er laget for å være offentlig.
2. **Ikke lag kopier av sider** (`hittegods (2).html`, `..._TEST.html`, `backup/`). Alt som ligger i repoet er en offentlig side. Endre `hittegods.html` direkte – GitHub tar vare på alle gamle versjoner.
3. **SMS-teksten bestemmes på serveren**, i `smsText()` i `supabase/functions/glemmekassen-sms/index.ts`. `buildSmsText()` i `hittegods.html` er bare forhåndsvisningen – endre begge hvis teksten skal endres.
4. **Instruksjonene til Claude ligger på serveren**, i `PROMPTS` i `supabase/functions/claude-proxy/index.ts`. Appen sender bare navnet på oppgaven (`ocr`, `item`). `live_ocr` ligger fortsatt på serveren, men appen bruker den ikke lenger. Nye oppgaver må legges til der. Modellen er Claude Haiku 5.5 (`claude-haiku-5-5`) – den billigste, og god nok til å lese nummer og farge.
5. **Tekst fra brukere eller lenker settes inn med `textContent`, aldri `innerHTML`.**
6. **Bilder lastes opp uten `x-upsert`** og med tilfeldig navn (`crypto.randomUUID()`). Bøtta tillater ikke listing.
7. **Ikke lagre telefonnummeret** – heller ikke som «hash». Personvernteksten nederst i `hittegods.html` må stemme med det koden faktisk gjør.

## Grenser og opprydding

- Maks 100 SMS totalt per døgn (`MAX_SMS_PER_DAY`), og maks 5 per minutt / 50 per døgn per IP.
- Maks 500 kall til Claude totalt per døgn (`MAX_AI_CALLS_PER_DAY` i `claude-proxy`), talt i tabellen `ai_bruk` (se `supabase/sql/ai-dagsgrense.sql`).
- Nummeret leses bare når brukeren trykker på kameraknappen (`capturePhoto()` i `hittegods.html`): ett bilde = ett kall til Claude. Ingen automatisk skanning – hvert kall koster penger.
- Hvis lesing av nummer slutter å virke: sjekk først kreditten på console.anthropic.com (Plans & Billing).
- Bilder og funn slettes automatisk etter 365 dager (`KEEP_DAYS`). Oppryddingen kjøres hver gang en SMS sendes.
- Bare norske mobilnummer (8 siffer, starter med 4 eller 9).

## Endre en serverfunksjon

Krever Supabase CLI og innlogging (`supabase login`). Fra repo-mappen:

```bash
supabase functions deploy glemmekassen-sms --project-ref jyajkriknplrhsxustpf --use-api --no-verify-jwt
```

Test etterpå med eget telefonnummer. Funksjonen må ha `--no-verify-jwt`, ellers slutter appen å virke.

## Slik jobber vi sammen

`main` er beskyttet: alle endringer går via en egen gren og en pull request. Du kan slå sammen din egen – ingen andre trenger å godkjenne.

**I GitHub, uten utviklerverktøy:**

1. Åpne filen og trykk blyanten («Edit this file»).
2. Gjør endringen og trykk «Commit changes».
3. Velg «Create a new branch for this commit and start a pull request», og trykk «Propose changes».
4. Se over diffen: grønt er lagt til, rødt er slettet.
5. Trykk «Merge pull request». Siden oppdateres ca. ett minutt etterpå.

**Bruk aldri «Add files via upload» med en fil du lastet ned tidligere.** Den bytter ut hele filen, så alt andre har endret i mellomtiden blir borte – uten at GitHub advarer. Blyanten redigerer alltid versjonen som ligger der nå, og sier fra hvis noen andre har endret filen imens.

**Se alltid over diffen før du slår sammen.** Mange slettede linjer du ikke kjenner igjen betyr som regel at en gammel versjon er på vei inn. Da er det bedre å stoppe og spørre.

**Fra maskinen:**

```bash
git switch -c kort-navn-på-endringen
git commit -am "Hva du endret"
git push -u origin HEAD
gh pr create --fill && gh pr merge --merge
```

## Teste

- glemmekassen.com oppdateres ca. ett minutt etter at endringer er slått sammen til `main` i GitHub. (Den gamle adressen heiditha.github.io/Glemmekassen virker fortsatt, men lenkene i SMS-en peker til glemmekassen.com.)
- Test hele flyten på mobil: ta bilde av navnelapp → bilde → sted → send → åpne lenken i SMS-en.
- Send bare test-SMS til eget nummer.
