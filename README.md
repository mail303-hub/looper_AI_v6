# DD Archery Looper v6.0 (PWA)

**Jaunums v6:** trešais trigera režīms **PHONE**: otrs telefons kalpo kā kustības sensors (**MOTION SENDER**) un pa internetu nosūta trigeri looper telefonam. Sk. sadaļu [PHONE trigeris](#phone-trigeris-v6).

Šaušanas treniņa "tūlītējais atkārtojums": telefons stāv pie mērķa, kamera un mikrofons strādā nepārtraukti.
Kad mikrofons dzird asu skaņu (bultas trāpījums, loka klikšķis, plaukšķis) **vai pienāk BLE signāls no ārējās ierīces**, lietotne uztaisa **īsu video** (noklusējumā 2 s:
1 s pirms skaņas + 1 s pēc skaņas; garums un attiecība regulējama), pati to atskaņo ciklā, un jūs izvēlaties **SAVE** vai **NEXT**.

(v6: **vai pienāk MOT no otra telefona** režīmā PHONE.)

Darbojas kā parasta tīmekļa lapa / PWA: **Android (Chrome)**, **iPhone/iPad (Safari, iOS 16.4+)** un **dators (Chrome/Edge)**.
Pēc pirmās ielādes darbojas **bez interneta**. Nav konta, reklāmu, analītikas, nekas netiek sūtīts uz tīklu (izņemot PHONE režīmu: tur caur publisku MQTT serveri tiek sūtīts tikai īss "MOT" ziņojums, nekad video vai skaņa).

---

## 1. Kā to palaist telefonā (bez GitHub)

Kamera un mikrofons pārlūkā strādā tikai **drošā lapā (https)**. Tāpēc failus vienreiz jāizliek bezmaksas hostingā.
Pēc tam telefonā atverat adresi un pievienojat sākuma ekrānam.

### A variants: Netlify Drop (vienkāršākais)

1. Datorā izpakojiet ZIP. Jums vajadzīga mape `dd-archery-looper` (tajā ir `index.html`, `app.js` u.c.).
2. Atveriet **https://app.netlify.com/drop** (iespējams, jāreģistrējas bez maksas ar e-pastu, lai lapa paliktu pastāvīgi).
3. **Ievelciet visu mapi** `dd-archery-looper` ar peli uz lapas laukumu.
4. Pēc dažām sekundēm saņemsiet adresi, piemēram `https://kaut-kas-123.netlify.app`. Šī ir jūsu lietotne.
5. Šo adresi atveriet telefonā (varat nosūtīt sev e-pastā vai WhatsApp).

> Citas bezmaksas iespējas bez GitHub: Cloudflare Pages ("Direct Upload"), Firebase Hosting. Princips tāds pats: mapi augšupielādē, saņem https adresi.

### B variants: tikai pārbaudei uz datora (bez hostinga)

`localhost` pārlūks uzskata par drošu, tāpēc uz datora var pārbaudīt uzreiz:

1. Atveriet termināli/komandrindu mapē `dd-archery-looper`.
2. Palaidiet: `python -m http.server 8000` (vai `python3 ...`; ja nav Python, tad `npx serve`).
3. Chrome atveriet **http://localhost:8000**.

(Telefonā, izmantojot datora IP adresi, tas **nestrādās**, jo tā nav https.)

### C variants: pārbaude telefonā no sava datora (https tunelis)

Kamerai, mikrofonam un kustības sensoram vajag https. Bez hostinga to var iegūt ar bezmaksas Cloudflare tuneli:

1. Mapē `dd-archery-looper_60`: `python -m http.server 8000`
2. Otrā terminālī: `cloudflared tunnel --url http://localhost:8000` (cloudflared lejupielāde: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ ; nav vajadzīgs konts).
3. Terminālī parādīsies adrese `https://kaut-kas.trycloudflare.com`: to atveriet abos telefonos.
4. Tunelis darbojas, kamēr abi termināļi ir atvērti; katru reizi adrese ir cita.

### Pievienot sākuma ekrānam ("instalēt")

| Ierīce | Kā |
|---|---|
| **Android (Chrome)** | Atveriet adresi, izvēlne ⋮ → **Instalēt lietotni** / **Pievienot sākuma ekrānam**. |
| **iPhone / iPad (Safari)** | Atveriet adresi **Safari**, poga **Kopīgot** (kvadrāts ar bultu) → **Pievienot sākuma ekrānam**. Vajag iOS/iPadOS **16.4 vai jaunāku**. |
| **Dators (Chrome/Edge)** | Adreses joslā ikona "Instalēt", vai izvēlne ⋮ → **Saglabāt un kopīgot → Instalēt lapu kā lietotni**. |

**Svarīgi:** pirmo reizi atveriet lietotni, kamēr ir internets, un ļaujiet tai pilnībā ielādēties. Pēc tam tā darbojas arī lidmašīnas režīmā.
Pārlūks jautās atļauju **kamerai** un **mikrofonam**: jāatļauj abas.
(iPhone Home Screen lietotnē atļauju jautājums var atkārtoties katrā palaišanā. Tā ir iOS īpatnība.)

v6: lietotne vienmēr vispirms ielādē jaunāko versiju no interneta (kešs tiek izmantots tikai bezsaistē), tāpēc pēc atjaunošanas pietiek ar lapas pārlādi. Versija redzama iestatījumu apakšā un MOTION SENDER ekrānā.

---

## 2. Kā lietot

1. Pastipriniet telefonu (orientāciju var mainīt iestatījumos). Pieskarieties **START**. Noklusējumā tiek izmantota **priekšējā kamera**.
2. Augšā kreisajā stūrī ir **zobrata poga ⚙**: tā atver **visus iestatījumus vienā logā**:
   - **Camera**: **Filming speed 30 / 60 fps** (kamera tiek atvērta no jauna ar izvēlēto kadru ātrumu; mikrofons netiek skarts). Ja kamera 60 fps neatbalsta, poga ir izslēgta un tiek rādīts paziņojums; ja kamera apgalvo 60, bet faktiski dod mazāk, lietotne atgriežas uz 30 fps. Zem pogām redzams **izmērītais** fps (reāli saņemtie kadri/s, atjaunojas ik 2 s) un kameras paziņotais fps. 60 fps pieprasījums vispirms tiek mēģināts ar stingru minimumu 50 fps vairākās izšķirtspējās (1280×720, 1920×1080, 960×540, 854×480, 640×480), jo daudzi telefoni 60 fps piedāvā tikai noteiktos režīmos; ja kamera 60 fps nepiegādā (piem., vājā apgaismojumā), paliek 30 fps. 60 fps dod 2× vairāk kadru klipā (SLOMO un kadru pārtīšana strādā tāpat). Izvēle saglabājas. Kameru saraksts un poga **Next camera** (pārslēdz uz nākamo pieejamo kameru; telefonā parasti priekšējā ↔ aizmugurējā, ja ir vairākas aizmugures kameras, tās nāk pēc kārtas). Izvēle tiek atcerēta. Pēc pārslēgšanas video buferis īsi uzkrājas no jauna (statuss "WARMING UP"), mikrofons netiek pārtraukts.
   - **Trigger input**: **MIC** vai **BT**. BT režīmā **mikrofons tiek pilnībā izslēgts** (nav pieprasīts, indikators nodziest). Lauks **DEVICE_NAME** (noklusējums `xiao_mg24_1`, maināms) nosaka, kādu ierīci meklēt; poga **Connect BT** atver pārlūka ierīču sarakstu. **BLE servisu UUID ir ieprogrammēti un nav maināmi** (lai tos nevarētu nejauši sabojāt): Seeed XIAO MG24 / Silicon Labs piemēra serviss `de8a5aac-a99b-c315-0c80-60d4cbb51224`, Nordic UART, Silicon Labs SPP, `ffe0`, Microchip UART, `fff0`. Lietotne abonē visus šo servisu raksturlielumus ar notify (MOT jāsūta kā **notify**). Ja neviens serviss netiek atrasts, parādās ziņojums un Debug žurnālā redzams, kas netika atrasts. Ja ziņojumā ir teksts **MOT**, tas ir līdzvērtīgs mikrofona signālam (viens signāls uz 1,5 s). Cipari aiz MOT (piem. `MOT45`) tiek rādīti augšā vidū kā **bat 45%**. Savienojuma pārrāvuma gadījumā lietotne pati mēģina pieslēgties atkal ik pēc ~2,5 s. Augšā vidū vienmēr redzams **MIC** vai **BT** (BT ✕ = nav savienojuma). Sync offset darbojas arī BT režīmā (BT aizture parasti prasa negatīvu vērtību, piem. −50…−150 ms).
   - **Microphone sensitivity** (BT režīmā neaktīva, izņemot Sync offset): **Calibrate (3 shots)**, slieksnis, skaņas līmeņa josla (zilā josla = skaņa, sarkanā svītra = slieksnis) un slīdnis (pa kreisi = jutīgāk, pa labi = mazāk jutīgi; diapazons −60…−0,5 dB). **Noklusējums ir mazākā jutība (−0,5 dB)**: tiek uztverti tikai ļoti skaļi šāvieni, kas sasniedz pilnu skaļuma līmeni; mazāk skaļiem jāsamazina slieksnis vai jāveic kalibrēšana. Jau saglabāts (kalibrēts) slieksnis netiek mainīts. Zemāk **Sync offset**.
   - **Video ring buffer**: **klipa garums 0,5–5 s** (solis 0,5 s, noklusējums **2 s**). Zem tā slīdnis **Signal position**: cik sekundes ir **pirms** signāla (kreisā puse no "|") un cik **pēc** tā (labā puse). Piem. 2 s klips: "0,5 s before | 1,5 s after". Noklusējumā signāls ir vidū. Lietotne gaida, kamēr ierakstīta visa "pēc" daļa, un tikai tad sāk atskaņošanu. Attiecība tiek glabāta kā daļa, tāpēc mainot garumu, tā saglabājas. Riņķa buferis atmiņā glabā klipa garumu + 1,5 s rezerves.
   - **AUTO MODE**: ja ieslēgts, signāli tiek uztverti arī **atskaņošanas laikā**. Nākamais signāls ierakstās fonā (augšā **AUTO ● REC**), un kad jaunais klips gatavs, tas **aizstāj** atskaņojamo un sāk atskaņoties automātiski. Vecais klips tiek izmests, ja nebija saglabāts ar SAVE. Statuss atskaņošanā: **AUTO ● LISTENING**. NEXT ierakstīšanas laikā atgriež LIVE, bet jaunais klips tik un tā tiks atskaņots, kad būs gatavs.
   - **Screen orientation**: **Landscape / Portrait**. Android Chrome (pilnekrāns vai instalēta lietotne) ekrānu nobloķē izvēlētajā orientācijā. iPhone/iPad un datorā pārlūks to neļauj: parādās ziņojums, un ierīce jāpagriež ar roku (jāizslēdz arī rotācijas bloķēšana). Lietotne darbojas abās orientācijās. Izvēle tiek atcerēta.
   - **Slow motion (SLOMO_SPEED)**: ātrums kadros sekundē, **1–30, noklusējums 7 fps**. To izmanto poga **SLOMO** atskaņošanas ekrānā (starp SAVE un NEXT).
   - **Playback zoom**: ieslēgt/izslēgt tuvināšanu atskaņošanā. Datorā: **peles rullītis** tuvina/tālina ap peles kursoru (līdz 8×), **Shift + vilkšana** (vai labā/vidējā poga) pārvieto attēlu. Zoom saglabājas nākamajiem klipiem līdz Reset zoom.
   - **Playback grid**: ieslēgt/izslēgt režģi atskaņošanā, **rūtiņas izmērs 30–200 px (noklusējums 100 px)**, **intensitāte 1–10** (caurspīdība: 1 = ļoti blāvs, 10 = pilnīgi nepārredzams), **krāsa**: black / white / red / green / blue. Kamēr iestatījumu logs ir atvērts, režģis redzams arī virs kameras attēla kā priekšskatījums.
   - Kalibrēšana: ~1,5 s klusumā (fona troksnis), tad **Shot 1/3**, **Shot 2/3**, **Shot 3/3** (katru reizi parasts šāviens), beigās **Calibration complete**. Slieksnis saglabājas.
   - Iestatījumi tiek atvērti LIVE režīmā; izmaiņas stājas spēkā nākamajam klipam. **Visi iestatījumi (arī klipa garums, signāla pozīcija, režģis, AUTO MODE, orientācija) saglabājas ierīcē un paliek spēkā pēc atkārtota starta.**
3. Aizveriet iestatījumus. Augšā redzams **● LISTENING**: lietotne gaida skaņu.
4. Pēc skaņas: **● REC** (kamēr tiek ierakstīta klipa otrā puse), tad automātiski sākas atskaņošana ciklā.
5. Atskaņošanā:
   - **Pieskāriens vidusdaļai** (vidējā puse no ekrāna platuma) = pauze / turpināt. **Pieskāriens kreisajai malai** (kreisais ceturksnis) = viens kadrs atpakaļ, **labajai malai** (labais ceturksnis) = viens kadrs uz priekšu (video apstājas, augšā redzams kadra numurs),
   - **Vilkšana ar vienu pirkstu pa horizontāli** = pārtīšana pa kadriem (pa labi = uz priekšu, pa kreisi = atpakaļ; ~8 px = 1 kadrs). Pēc vilkšanas video paliek pauzē, līdz atkal pieskaraties,
   - **Divi pirksti** (ja ieslēgts Playback zoom): **savelkot/paplašinot** maina tuvinājumu (līdz 8×), pavelkot abus pirkstus pārbīda attēlu. Zoom **paliek spēkā arī nākamajiem klipiem**, līdz nospiežat **Reset zoom** (kreisajā augšējā stūrī, parādās, kad ir tuvinājums). Izslēdzot Playback zoom iestatījumos, tuvinājums tiek atcelts,
   - **SLOMO** (poga **pa vidu starp SAVE un NEXT**): ieslēdz lēno kustību ar ātrumu SLOMO_SPEED (kadrs pa kadram, cikliski); poga iedegas zila un rāda ātrumu. Nospiežot vēlreiz, atgriežas normāls ātrums. SLOMO paliek ieslēgts arī nākamajiem klipiem, līdz to izslēdzat. Vidus pieskāriens = pauze/turpināt, malu pieskārieni = 1 kadrs arī lēnajā režīmā. Saglabātais video vienmēr ir normālā ātrumā,
   - **SAVE**: saglabā MP4 (`DD_Archery_YYYYMMDD_HHMMSS.mp4`). **Ja atskaņošanā ir ieslēgts zoom (tuvinājums > 1×) vai režģis, saglabātais video satur tieši to, ko redzat**: to pašu tuvinājumu un nobīdi no centra, kā arī to pašu režģi (izmērs, krāsa, intensitāte). Tas tiek pārkodēts (parasti 1–3 s, pogā uzraksts RENDERING…). Bez zoom un režģa tiek saglabāts oriģinālais klips uzreiz. Ja pārkodēšana neizdodas, tiek saglabāts oriģināls un parādās piezīme,
   - **NEXT**: izmet klipu un uzreiz atgriežas LIVE režīmā (neko nesaglabā),
   - **EXIT**: izslēdz kameru, mikrofonu un visu pārējo.
   Visas pogas un uzraksti virs video ir mazi (SAVE/NEXT ~30 px augsti), lai netraucētu skatīt video. SAVE un NEXT, un tās nenostrādā uzreiz pēc vilkšanas/tuvināšanas žesta.

**Kur nonāk saglabātais fails:**
- Android un dators: mape **Lejupielādes / Downloads** (pārlūks neļauj rakstīt tieši uz `Movies`).
- iPhone/iPad: atveras kopīgošanas lapa, izvēlieties **Saglabāt video** (uz Fotoattēliem) vai **Saglabāt failos**.

**Sync offset** (iestatījumu logā): ja skaņa atskaņojumā nav precīzi vidū (kameras un mikrofona aizture atšķiras katrai ierīcei), pabīdiet par dažām desmitdaļām milisekundēm. Pozitīva vērtība pabīda klipa logu vēlāk laikā.

**Debug**: iestatījumu logā poga **Debug** atver iekšējo žurnālu **visā iestatījumu logā** (liels, ritināms, ar pogu **Copy log**) (faktiskais kameras FPS, trigera laiks, klipa sākums/beigas, kadru skaits, eksporta laiks, slieksnis). Normālā režīmā tas nav redzams.

---

## PHONE trigeris (v6)

Vajag divus telefonus ar internetu (Wi-Fi vai mobilie dati, var būt dažādos tīklos).

**Looper telefons** (tas, kas filmē):
1. Sākuma ekrānā **START LOOPER (PHONE TRIGGER)** (vai ⚙ → Trigger input → **PHONE**).
2. Augšā vidū redzams **PHONE ROOM XXXXXXXX**: tas ir šī telefona **ROOM CODE** (8 burti/cipari, izveidots vienreiz un paliek tas pats). Zaļš PHONE = savienots, sarkans **PHONE ✕** = nav savienojuma (lietotne pati mēģina atkal ik pēc 2,5…15 s; statuss **PHONE CONNECTING / RECONNECTING**).
3. ⚙ → **Phone trigger**: ROOM CODE (var ievadīt savu, vismaz 6 simboli), **Copy code**, **New code** (jauns nejaušs kods), serveris zem **Server settings** (paslēpts, atver ar pieskārienu; noklusējums `wss://broker.emqx.io:8084/mqtt`, poga **Restore default server** to atjauno), **Sensor threshold** (sensora telefona jutība 5–100 m/s², poga **Restore default threshold (15)**; to var mainīt gan looperī, gan sensora telefonā; abi paliek vienādi, uzvar pēdējā izmaiņa), **Connect / Disconnect** un statuss (arī pēdējā saņemtā MOT laiks un stiprums).
4. PHONE režīmā mikrofons ir izslēgts (kā BT režīmā). Atpakaļ uz **MIC** var pārslēgties bez restarta.

**Sensora telefons** (piestiprināts pie loka, rokas u.tml.):
1. Atver to pašu adresi, sākuma ekrānā **MOTION SENDER** (kamera netiek ieslēgta).
2. Ievada looper telefona ROOM CODE, iestata **Threshold** (5–100 m/s², noklusējums **15 m/s²**; pa kreisi = jutīgāk). Slieksnis ir kopīgs ar looper **Sensor threshold**: izmaiņa vienā ierīcē parādās otrā, uzvar pēdējā (serveris glabā pēdējo vērtību, tēma `ddarchery/v1/<ROOM>/config`; izmaiņa bez savienojuma netiek nosūtīta). **Last peak** rāda lielāko kustības stiprumu 1 s laikā pēc pēdējā trigera, lai var izvēlēties slieksni. Šo vērtību redz arī looper ierīcē: augšējā joslā (`ROOM … · peak 63.0`) un ⚙ → Phone trigger statusā.
3. **CONNECT & START SENSOR**. iPhone jautās atļauju kustības sensoram (jāatļauj). Ekrāns netiek izslēgts (Wake Lock), lietotnei jāpaliek priekšplānā.
4. Kad sensors sāk darboties, ekrāns **nobloķējas**: tas kļūst melns, nereaģē uz pieskārieniem (telefonu var turēt rokā vai kabatā), lapa pāriet **pilnekrāna režīmā** (pazūd pārlūka joslas un, kur sistēma atļauj, arī navigācijas pogas; orientācija tiek nofiksēta), redzams tikai punkts (zaļš = savienots, sarkans = nav savienojuma, balts uzplaiksnījums = MOT nosūtīts) un mazs **zobrats ⚙** labajā augšējā stūrī. Iestatījumi atveras tikai, ja zobratu **tur nospiestu ~1 s** (īss pieskāriens parāda tikai padomu). Atvērtajos iestatījumos ir **Hide** (atpakaļ uz bloķēto ekrānu), **Stop**, **Back**; ja 20 s nekas netiek aiztikts, ekrāns nobloķējas pats. Ja pilnekrāns tiek pamests (piem. ar sistēmas "atpakaļ" žestu), pietiek pieskarties melnajam ekrānam, un tas atjaunojas. **iPhone Safari pilnekrānu tīmekļa lapām neatbalsta**: tur pievienojiet lietotni sākuma ekrānam (Kopīgot → Pievienot sākuma ekrānam) un palaidiet no turienes, tad pārlūka joslu nav.
5. Atvērtajos iestatījumos josla rāda kustības stiprumu (sarkanā svītra = slieksnis). Kad paātrinājums (bez gravitācijas) pārsniedz slieksni, tiek nosūtīts **MOT** (ne biežāk kā reizi sekundē; nākamais tikai pēc tam, kad kustība norimst). **Send test** nosūta MOT ar roku (noder pārbaudei, arī no datora).

Looper telefonā MOT darbojas tieši tāpat kā mikrofona vai BT signāls (1,5 s bloķēšana, AUTO MODE, Sync offset). Interneta aizture parasti ir 0,1–0,4 s: ja šāviens klipā ir par vēlu, iestatiet **Sync offset** negatīvu (piem. −150…−300 ms).

Tehniski: MQTT 3.1.1 caur drošu WebSocket (paša rakstīts klients `phone.js`, bez bibliotēkām), tēma `ddarchery/v1/<ROOM>/trigger`, ziņojums `{"type":"MOT","a":4.2,"ts":...}`. Der arī vienkāršs teksts, kas satur `MOT` (piem. no mikrokontroliera). Serveris ir publisks: ikviens, kas zina ROOM CODE, var nosūtīt trigeri, tāpēc kodu nestāstiet citiem (vai nospiediet New code).

---

## 3. Kā tas strādā (īsi)

- Kamera → kadri → **WebCodecs H.264 kodētājs** → **riņķa buferis atmiņā** (klipa garums + 1,5 s kodētu kadru; pie 2 s tas ir ~2–3 MB, pie 5 s ~5 MB). Uz diska netiek rakstīts nekas, tāpēc nav iespējams, ka krātuve aug.
- Atslēgas kadrs ik pēc 10 kadriem (~0,33 s). Klipa sākums tiek apgriezts **precīzi pie T minus "pirms" laiks** ar MP4 rediģēšanas sarakstu (edit list).
- Mikrofons → **AudioWorklet** (audio pavediens, nevis UI): trokšņa slāpēšana, auto-pastiprinājums un echo cancellation ir izslēgti. Skaņa jāpārsniedz slieksni **un** jābūt skaidri skaļākai par fona līmeni (īss, ass impulss). Pēc trigera 1,5 s bloķēšana, lai viens šāviens nedotu vairākus trigerus. Kalibrēšanas laikā trigeri ir atslēgti.
- Pēc trigera lietotne **gaida, līdz ierakstīta vēl 1 s**, un tikai tad saliek MP4 (paša rakstīts MP4 sapakotājs `mp4.js`, nav ārējo bibliotēku) un sāk atskaņošanu.
- Rezultāts (noklusējumā): 2,000 s, parasti 60 kadri pie 30 FPS, trigers klipa vidū. Ar citu garumu/attiecību tas pats princips.

Faili: `index.html`, `style.css`, `app.js` (loģika), `core.js` (sliekšņa matemātika, klipa izvēle), `mp4.js` (MP4 sapakotājs), `phone.js` (PHONE trigeris: MQTT klients, ROOM kods, kustības detektors), `audio-worklet.js` (detektors), `sw.js` (bezsaistes kešs), `manifest.webmanifest`, `icons/`.

---

## 4. Manuālā testēšanas pārbaude

| # | Pārbaude | Gaidāmais rezultāts |
|---|---|---|
| 1 | Atvērt lietotni, START, atļaut kameru/mikrofonu | Redzams kameras attēls pilnekrānā, augšā **● LISTENING** (pēc ~1 s) |
| 2 | Klusums / parasts fona troksnis | Nav trigeru |
| 3 | ⚙ → Calibrate, 3 šāvieni | Parādās Shot 1/3, 2/3, 3/3, Calibration complete; slieksnis saglabāts (aizvērt un atvērt lietotni: vērtība paliek) |
| 4 | Slīdnis | Pa kreisi: arī klusākas skaņas trigero; pa labi: tikai skaļas |
| 5 | Viens plaukšķis/šāviens | **Viens** trigers; ~1 s **● REC**, tad atskaņošana. Atskaņošana nesākas agrāk par 1 s pēc skaņas |
| 6 | Klipa garums | ~2 s (debug žurnālā frames ≈ 60), skaņa apmēram vidū |
| 7 | Atskaņošana | Cikliski atkārtojas |
| 8 | Pieskāriens | Pauze / turpināt |
| 9 | Vilkšana pa labi / pa kreisi | Pārtīšana pa kadriem, pēc vilkšanas pauze |
| 10 | Vilkšana, kas beidzas virs SAVE/NEXT | Poga **nenostrādā** |
| 11 | SAVE | Paziņojums "Saved"; fails ar laika zīmogu Downloads (iPhone: Saglabāt video); atveras galerijā/atskaņotājā kā MP4 (H.264) |
| 12 | SAVE divreiz vienā sekundē | Faili netiek pārrakstīti (jauns vārds) |
| 13 | NEXT | Klips izmests, uzreiz LIVE, nākamais šāviens strādā |
| 14 | Divi šāvieni pēc kārtas (ātri) | Otrs nenostrādā atskaņošanas laikā, pēc NEXT atkal strādā |
| 15 | EXIT (LIVE un atskaņošanā) | Kamera un mikrofons izslēdzas (zaļais/oranžais indikators pazūd), parādās "Stopped" |
| 16 | Aizliegt kameras vai mikrofona atļauju | Saprotams paziņojums, nav avārijas |
| 17 | Pārslēgties uz citu lietotni un atpakaļ | Lietotne apstājas un prasa START, nav avārijas |
| 18 | Lidmašīnas režīms (pēc pirmās ielādes) | Lietotne atveras un strādā |
| 19 | 30+ minūtes darbs | Atmiņa/krātuve neaug; ekrāns neuzglabājas miega režīmā |
| 20 | Zobrata poga ⚙ | Atveras viens iestatījumu logs ar kameru, mikrofonu, klipa garumu, AUTO MODE, orientāciju, zoom un režģi |
| 21 | Kameras: sarakstā izvēlēties citu; poga Next camera | Attēls pārslēdzas, mikrofons strādā tālāk, pēc ~1 s atkal "LISTENING". Pēc START atkal ir izvēlētā kamera (noklusējumā priekšējā) |
| 22 | Klipa garums 0,5 / 4 / 5 s | Klips ir attiecīgi garš, atskaņošana sākas pēc "pēc" daļas |
| 23 | Playback zoom ieslēgts, savilkt/paplašināt divus pirkstus | Attēls tuvinās/pārvietojas; Reset zoom parādās augšā pa kreisi; nākamajā klipā tuvinājums saglabājas; Reset zoom to atceļ |
| 24 | Playback zoom izslēgts | Tuvināšana nedarbojas, Reset zoom nav redzams |
| 25 | Grid: ieslēgt, izmērs 30–200 px, intensitāte 1–10, krāsas | Režģis redzams atskaņošanā (un kā priekšskatījums, kamēr iestatījumi atvērti); līnija iet caur ekrāna centru |
| 26 | SAVE/NEXT | Pogas ir zemas (apm. uz pusi zemākas nekā v1) un joprojām viegli nospiežamas |
| 27 | Signal position slīdnis (piem. 0 s / 1,5 s / 2 s no 2 s) | Teksts "X s before \| Y s after"; klipā signāls attiecīgajā vietā; atskaņošana sākas pēc "after" daļas |
| 28 | Grid noklusējums pēc svaigas instalēšanas | 100 px; izmainītās vērtības (grid, garums, pozīcija) paliek pēc EXIT un jauna START |
| 29 | AUTO MODE ieslēgts: atskaņošanas laikā otrs šāviens | Augšā AUTO ● REC, pēc brīža atskaņojas jaunais klips; vecais pazūd |
| 30 | AUTO MODE izslēgts: šāviens atskaņošanas laikā | Netiek uztverts (kā v1.1) |
| 31 | Landscape / Portrait | Android: ekrāns nobloķējas; iPhone/dators: ziņojums "rotate the phone" |
| 32 | BT režīms: ⚙ → BT, izvēlēties xiao_mg24_1 | Augšā vidū "BT" (zaļš), mikrofona indikators pārlūkā nodziest |
| 33 | BT: ierīce sūta "MOT" | Kā mikrofona signāls: ● REC, pēc "after" daļas atskaņošana |
| 34 | BT: ierīce sūta "MOT45" | Augšā vidū "bat 45%" + signāls |
| 35 | BT: izslēgt ierīci / atnest atpakaļ | "BT ✕", "BT RECONNECTING", pēc ieslēgšanas atkal savienojas pats |
| 36 | DEVICE_NAME nomaiņa, tukšs lauks | Saglabājas; tukšs = xiao_mg24_1 |
| 37 | Atpakaļ uz MIC | Mikrofons ieslēdzas, BT atvienojas, bat teksts pazūd |
| 38 | Pieskāriens ekrāna kreisajai/labajai malai atskaņošanā | −1 / +1 kadrs; vidus = pauze/turpināt |
| 39 | Zoom + grid ieslēgts, SAVE | Saglabātajā video redzams tas pats tuvinājums/nobīde un režģis kā atskaņošanā |
| 40 | SLOMO poga | Atskaņo ar SLOMO_SPEED (7 fps), poga zila; vēlreiz = normāli |
| 41 | SLOMO_SPEED settingos | Maina ātrumu; saglabājas pēc restarta |
| 42 | Filming speed 60 fps | Kamera pārslēdzas, klipā ~120 kadru; ja nav atbalsta, paziņojums |
| 44 | PC: peles rullītis atskaņošanas logā (Playback zoom ieslēgts) | Tuvina ap kursoru, Shift+vilkšana pārvieto, Reset zoom atceļ |
| 43 | Debug | Žurnāls aizņem visu logu; Copy log nokopē tekstu |
| 45 | START LOOPER (PHONE TRIGGER) | Augšā "PHONE ROOM XXXXXXXX", pēc brīža zaļš PHONE un ● LISTENING |
| 46 | Otrā telefonā MOTION SENDER, ievadīt kodu, CONNECT & START SENSOR | "Connected, room …"; kustinot josla kustas |
| 47 | Asi pakustināt sensora telefonu | Sensora telefonā "MOT sent"; looper telefonā ● REC un atskaņošana |
| 47a | Sensora ekrānā pieskarties jebkur (arī tur, kur bija Stop/Back) | Nekas nenotiek, sensors strādā; īss pieskāriens ⚙ = padoms, turēt ⚙ ~1 s = iestatījumi |
| 48 | Send test divreiz ātri pēc kārtas | Looper telefonā tikai viens trigers |
| 49 | Izslēgt internetu looper telefonam un ieslēgt atpakaļ | PHONE ✕ / PHONE RECONNECTING, pēc tam savienojas pats |
| 50 | ⚙ → New code | Jauns kods augšā; sensora telefonā jāievada jaunais kods |
| 51 | PHONE → MIC → PHONE iestatījumos | Mikrofons ieslēdzas bez restarta, atpakaļ PHONE savienojas no jauna |

---

## 5. Zināmie ierobežojumi

- **Nav Android APK.** Šī ir tīmekļa versija. Tā nevar rakstīt uz `Movies/DD Archery Looper` (pārlūka drošības ierobežojums): Android/datorā fails nonāk **Downloads**, iPhone tiek nodots caur kopīgošanas lapu.
- **EXIT** apstādina kameru, mikrofonu un visus resursus un parāda "Stopped", bet **pārlūks neļauj lapai pašai aizvērties**: aizveriet lietotni ar roku (sistēmas lietotņu pārslēdzējs).
- Lietotnei jābūt **priekšplānā ar ieslēgtu ekrānu**: pārlūki aptur kameru un mikrofonu fonā. Ekrāna izslēgšanos novērš Screen Wake Lock (iOS 16.4+, Android Chrome, dators). Ja ierīce to neatbalsta, ekrāns var nodziest.
- **Klipā nav skaņas** (tikai video).
- **Next camera** iet cauri visām kamerām, ko ierīce piedāvā (arī platleņķa/tālummaiņas), nevis tikai priekšējā/aizmugurējā. Kameru nosaukumi var būt vispārīgi ("Camera 1"), līdz pārlūks ir saņēmis atļauju.
- **Zoom** darbojas ar diviem pirkstiem uz skārienekrāna. Datorā bez skārienekrāna (peles ritenītis) tuvināšana nav pieejama.
- Režģa rūtiņas izmērs ir **CSS pikseļos** (ekrāna "loģiskajos" pikseļos), nevis reālos centimetros vai kameras pikseļos. Režģis ir uz ekrāna un netiek saglabāts klipā.
- Pārslēdzot kameru vai mainot klipa garumu, buferim jāuzkrājas no jauna (līdz "pirms" daļa + 0,1 s), pirms atkal tiek klausīta skaņa.
- **FPS** nosaka kamera un apgaismojums. Pārlūks nevar piespiest tieši 30 FPS: tumsā kamera bieži krīt zem 30, un klipā būs mazāk par 60 kadriem (laiks tik un tā ir pareizs, 2,000 s pēc noklusējuma). Faktisko FPS skatiet Debug žurnālā.
- Skaņas un video sinhronizācijai ir neliela ierīces atkarīga nobīde (parasti dažas desmitdaļas sekundes): regulējama ar **Sync offset**.
- Detektors reaģē uz **skaļumu un straujumu**, nevis atpazīst skaņas veidu: citi asi trokšņi (aplausi, durvju klaudziens) arī var trigerot. Vējš un sarunas parasti netrigero, bet jāpārbauda uz vietas un jākalibrē.
- Dažās ierīcēs (īpaši dažos iPhone) sistēma var tomēr pielietot mikrofona apstrādi. Ja jutība šķiet nepastāvīga, pārkalibrējiet.
- Galerijas lietotnes, kas ignorē MP4 rediģēšanas sarakstu, var parādīt līdz ~0,33 s liekā video klipa sākumā (Chrome, Safari, VLC to ievēro).
- Nepieciešams WebCodecs: **Chrome/Edge 94+**, **Safari/iOS 16.4+**. Vecākas ierīces un lielākā daļa citu pārlūku nav atbalstīti.
- **Lietotne izstrādes vidē nav pārbaudīta ar īstu kameru un mikrofonu.** Pārbaudīta ir loģika ar simulētu kameru/kodētāju/mikrofonu (trigers, 1 s gaidīšana, klipa salikšana, žesti, SAVE/NEXT/EXIT) un izveidotais MP4 ir validēts ar ffprobe/ffmpeg (H.264, 2,000 s, 60 kadri). Pirmā pārbaude uz jūsu telefona ir obligāta; ja kaut kas nestrādā, atveriet **⚙ → Debug** un nosūtiet žurnāla tekstu.

- **Orientācijas bloķēšana** darbojas tikai tur, kur pārlūks to atļauj (Android Chrome pilnekrānā/instalēta). Citur jāpagriež ierīce.
- **BT darbojas tikai pārlūkos ar Web Bluetooth: Android Chrome un datora Chrome/Edge.** **iPhone/iPad Safari to neatbalsta** (arī Chrome uz iPhone ne): tur BT režīms nav izvēlams, ir tikai mikrofons. (Pārlūks Bluefy uz iPhone Web Bluetooth atbalsta, bet ar šo lietotni nav pārbaudīts.) BT pirmajā reizē jāizvēlas ierīce no saraksta (pārlūka drošības prasība); pēc tam daudzos Chrome gadījumos tā atceras ierīci un pieslēdzas pati.
- BT ziņojuma formāts un servisa UUID man nav zināms: lietotne pieņem jebkuru tekstu, kas satur "MOT" (reģistrs nav svarīgs), un abonē visus notify raksturlielumus norādītajā servisā. Ja ierīcē nav neviena no norādītajiem servisiem, parādās kļūdas ziņojums (un Debug žurnālā redzams, kuri UUID netika atrasti).
- **SAVE ar zoom/režģi** pārkodē video (WebCodecs), tāpēc kvalitāte ir ļoti tuva, bet ne identiska oriģinālam. Uz iPhone kopīgošanas lapa pēc pārkodēšanas dažkārt netiek atvērta (pārlūks pieprasa tūlītēju pieskārienu); tad fails tiek lejupielādēts.
- **AUTO MODE**: ja šāvieni seko ļoti cits citam (ātrāk nekā klipa "pēc" daļa + 1,5 s bloķēšana), daži netiks uztverti.

- **PHONE**: abiem telefoniem vajag internetu un publiskā MQTT servera pieejamību (daži uzņēmumu/skolu Wi-Fi bloķē portu 8084; tad lietojiet mobilos datus vai citu `wss://` serveri). Aizture atkarīga no tīkla (parasti 0,1–0,4 s, var svārstīties), tāpēc precizitāte ir mazāka nekā MIC/BT. Sensora telefonam jābūt priekšplānā ar ieslēgtu ekrānu.

## 6. Nākamā versija (ja vajag)

Ja nepieciešama precīza `Movies` mape, darbs fonā vai ierīces ar nestabilu pārlūka kameru, to pašu loģiku (riņķa buferis + 60 kadru logs) var pārnest uz natīvu Android lietotni (Camera2 + MediaCodec), kā paredzēts specifikācijas "V2" daļā.
