# Research and design brief: a browser successor to Audiosurf 2

Project: **hypersurf**. A static site (GitHub Pages) with three song sources:
1. **Local audio file.** Full offline analysis with whole-song lookahead, as in Audiosurf.
2. **Built-in synthesized demo song.** Generated in-browser, and doubles as the analysis test fixture.
3. **YouTube.** A visible embedded player; the game analyzes the tab audio live, after the user shares it through the browser prompt (see §2.2 and §5). Early research also covered a tap-tempo "Beat Sync" alternative that never touches audio; the project chose live listening.

Tech: three.js `WebGPURenderer` (it falls back to its WebGL2 backend automatically), TSL node materials, bloom and post-processing, instancing everywhere, and zero allocation per frame.

Tags: **(unverified)** means a skeptic could not confirm the point. **(single source)** means one community source. Corrections from the skeptics are already applied.

---

## 1. Audiosurf 2 deep dive

### 1.1 Song → track

- **Whole-song pre-analysis.** Fitterer: "It analyzes the entire song before play begins so the gameplay pacing and procedural geometry can be synchronized ahead of time" ([Game Developer, 2007](https://www.gamedeveloper.com/game-platforms/road-to-the-igf-i-audiosurf-i-making-waves-with-music)). That quote is about AS1. For AS2, mode and skin Lua run on the loading screen, and `GetTrack()` returns every node of the whole song ([skin guide](https://steamcommunity.com/sharedfiles/filedetails/?id=413812198), [DBN skins](https://as2-doc.deathbynukes.com/skins.html)). Results are cached per song (.ash/.asa; community-reported).
- **Core mapping.** "You go downhill (fast) when your music is intense and uphill when your music is calm" ([GDC 2008](https://aggrogamer.com/article/3/GDC-2008-Interview-Audiosurf)). A 2025 guide confirms that in AS2 steeper downhill means more speed and more traffic ([JP guide](https://steamcommunity.com/sharedfiles/filedetails/?id=3617069765)). This is the default only: the `alldownhill` setting removes uphill sections.
- **Track node fields.** `seconds`, `intensity` (0-1, normalized = intensity / the song's most intense part), `color` (from intensity), `trafficstrength` (a block exists where it is > 0), `pos`, `pan/tilt/roll` (absolute degrees), and `funkyrot` (loop/corkscrew; the guide calls it "experimental and unreliable"). Mods also get `maxair` and `jumpairtime` ([mods](https://as2-doc.deathbynukes.com/mods.html), [glossary](https://as2-doc.deathbynukes.com/glossary.html)). The track also has negative-time lead-in nodes and 44 cloned tail nodes ("currently"). Intensity "is different from the track slope."
- **Intensity and block strength are separate signals.** Busy riffs and percussion give many blocks. A loud song with little percussive content can give few ([JP guide](https://steamcommunity.com/sharedfiles/filedetails/?id=3617069765)). The guide says AS2 has "no BPM concept" (single source; consistent with the API).
- **How far the algorithm is known.** Decompilation recovered only the first stage: a Kiss FFT 512-bin spectrum turned into per-frame √-magnitude "sums" ([yashgen](https://github.com/sk-zk/yashgen)). Onset picking, slope and block generation remain undocumented.
- **Generation parameters** (API defaults / the vanilla-Mono copy):
  - speed 0.1–2.9 (Mono copy: 3.1; units undocumented)
  - uphill/downhill tilt scaler 0.8/1.55 (Mono copy: 1.5/1.5)
  - tilt smoothers 0.03/0.06
  - `trafficcompression` 0.65 (Mono copy: 0.69)
  - `minimumbestjumptime` 2.5 s
  - sources: [mods](https://as2-doc.deathbynukes.com/mods.html), [MonoWithMedals](https://raw.githubusercontent.com/PodnimatelPingvinov/MonoWithMedals/master/mono%20with%20medals.lua)
- **AS1 history.** Blocks were "basically random" for most of AS1's development. Beat-sync came late, after his wife "convinced me that was not a good idea" ([PC Gamer](https://www.pcgamer.com/the-making-of-audiosurf-the-synesthesia-simulator/)).

### 1.2 Mono, the mode that matters

Mono is the mode critics singled out: IGN's "excellent Mono mode carries" the game ([Wikipedia](https://en.wikipedia.org/wiki/Audiosurf_2)). It is also the most-played mode on the community server, with about 796k plays, roughly half of all recorded mode plays and about 6.4 times the next mode ([audiosurf2.info](https://audiosurf2.info/modes); the "~68%" figure elsewhere is wrong).

Rules below come from a mod that copies the stock Mono script ([MonoWithMedals](https://raw.githubusercontent.com/PodnimatelPingvinov/MonoWithMedals/master/mono%20with%20medals.lua)), checked against the [Capes](https://steamcommunity.com/sharedfiles/filedetails/?id=1916096771), [Cilfaen](https://steamcommunity.com/sharedfiles/filedetails/?id=626994175) and [JP](https://steamcommunity.com/sharedfiles/filedetails/?id=3617069765) guides.

| Rule | Value |
|---|---|
| Lanes | 3, at x = −3/0/+3; dividers ±1.5, shoulders ±4.5, track width 5. Collision snaps to the nearest lane, so a ship cannot straddle two lanes. |
| Hit window | Asymmetric: colour blocks and PBs collide from 0.1 node ahead to **2.1 nodes behind**, greys only to **0.5 behind**, so colours are forgiving and greys are tight (mod's `Collide()`; node duration undocumented). Ours, in time: colour/PB −20…+70 ms, grey −10…+18 ms around impact (same ~4:1 ratio; tunable). |
| Grid | 3 columns × 7 rows. A block drops into the column matching its lane. |
| Grey selection | All blocks start as colour. The weakest `floor(23%)` by strength, plus the longest-span 5%, become grey (the sets overlap, so at most ~28%). Any grey with span > 0 becomes a "caterpillar". |
| Lanes | `math.random(-1,1)`, seeded with milliseconds since startup, so a **new layout on every play**. Power blocks sit in lane 0. |
| Spacing | A different-type block within 4 nodes or 0.15 s is moved out of the previous block's lane. A same-type block < 0.2 s away never forms an outer-outer pair. |
| Match | ≥3 connected blocks start the timer. `matchcollectionseconds` = 1.5 s for Mono (confirmed). Ninja 1.5 s and Casual 1.75 s come from a **single source, which contradicts itself**. |
| Timer | Resets on hitting a block (Mono/Casual: greys too). Riding a chainspan pauses it. A falling block holds it for about 0.25 s + 0.1 s per empty row (the scripts' values; the guide's 0.05 s is wrong). |
| Score | 35·n² per connected match (3 = 315, 7 = 1,715, 21 = 15,435). With the centre column empty, the outer columns score separately (each only with > 2 blocks). |
| Cash-in | Timer expiry, or **overfill**: an 8th block onto a full column scores the connected groups and seeds the new grid. Within about 1 s of a power block, an overfill gives a much smaller "PB overfill" result. |
| Grey hit | `eraseone`: removes the top block of that column and resets the timer. There is no penalty for taking many, so greys are a tool. |
| Chainspans | Lines under blocks for held tones. `chainstart…chainend` can begin before the block. Riding one pauses the match timer, even if you dodge its block. |
| Power blocks | Nodes with `jumpairtime ≥ 2.4 s`, only after node 300, up to `songMinutes + 2` per song, with a 10 s skip after each landing. Rank 1 is the "big" one. Every PB gets a loop: the big one a double corkscrew, the weakest a plain loop, the rest a single corkscrew. |
| PB effect | With a live match: ×1.5 (big ×2) that match. With no match: the grid is **duplicated**. PBs are about 25% of a good score (player estimate). |
| End bonus | Clean Finish +10% if the grid is empty. Stock Mono has no stealth bonus (the code is commented out). |

- **Ninja:** faster, with dense spike fields. A spike wipes the whole grid (`eraseall`, single source). It has a stealth bonus and no Clean Finish. The bonus is **likely 25%**: two stock-Ninja copies use `score*.25`, while guides say "~20% or more" (**unverified** against the shipped `ninja.lua`). Ninja Turbo is faster still. Speed ranges in the stock-derived copies: Mono 0.1–3.1, Ninja 0.1–3.9 (×1.26), Ninja Turbo 0.3–4.5 (×1.45).
- **Casual:** a slower Mono with shoulder lanes and few power blocks.
- **Mono Classic / Mono Turbo:** former early-access official modes, now Workshop mods by Dylan. Not part of today's official lineup.
- **AS1 note:** Ninja Mono had widen + shuriken. Jump belonged to Mono Pro, not Ninja Mono.

### 1.3 Other modes (context only)

- **Puzzle League** (Pointman, Pusher, Vegas, Eraser; one shared scoreboard):
  - 4 colours; white blocks are +1,500 at the bottom row.
  - **Per-colour base values conflict:** 11/22/33/44·n² (JP guide, single source), 30/35/40/45·n² (inferred from a 2014 player's 3-match test), 10/20/30/40·n² (stock-derived mod code). All **unverified**.
  - Chain: 1.0/1.5/1.9/2.25/2.5 … 4.0× at 30+ matches, with a 1.5 s window.
  - Match points = base × (2·chain + pickup − 1) ([Luzzifus](https://steamcommunity.com/sharedfiles/filedetails/?id=377815739)).
  - Multicolour +20/25/30%; Clean Finish 15%; Butter Ninja 7.5% and Seeing Red 5% (90% of yellow/red).
  - Overfill resets the chain and clears 3 rows.
  - Puzzle modes are rarely played (Pointman about 7.5k plays).
- **Wakeboard:** two tow boats; jump the wake at "big moments". Tricks gated by airtime pay 400/1k/3k/10k for 1/2/3/5 s (the pairing is inferred). It is divisive and little played ([blog](https://blog.audiosurf2.com/post/59475069128/audiosurf-2s-new-wakeboard-mode-is-based-on)).
- **Results:** raw score → mode bonuses → final score. Per-song boards per mode (Global/Regional/Friends/Dethrones), live in-song ghost scores and Song of the Day. Today these are kept alive by a community patch ([Cilfaen](https://steamcommunity.com/sharedfiles/filedetails/?id=626994175), [audiosurf2.info](https://audiosurf2.info/)). Different encodes of one song produce different tracks on the same board ([Capes](https://steamcommunity.com/sharedfiles/filedetails/?id=1916096771)).

### 1.4 Visuals and feel

- **Base look:** "pulsing neon tracks against a backdrop of inky blackness or a sheer white void" ([PC Gamer](https://www.pcgamer.com/a-love-letter-to-audiosurf-2s-dusk-skin/)). Official skins: Classic, Neon, Stadium, Dusk, Mystical. Sandstorm is an early-access skin, **not** mode-specific. The Dusk night drive, where spikes become tail-lights, is the critics' favourite.
- **Highway colour** is the main reactive channel. A calm→intense gradient (`SetTrackColors`; the first colour is the calmest) tints the rails, sky, ambient light, water, skywires, thrusters and Mono blocks. It can come from album art (3-5 colours) ([skin guide](https://steamcommunity.com/sharedfiles/filedetails/?id=413812198)). "Default is cool→hot" is a convention (hedged), not enforced. Greyscale palettes make blocks look like spikes, which is why `OverrideTrackColorForDynamicBlockColors` exists.
- **Other reactive channels:**
  - rings at intense nodes (`percentringed` ~0.15-0.2)
  - air debris that flashes on block hits
  - 16-band / 512-bin spectrum hooks (Kiss FFT)
  - mesh morphs by intensity (including smooth rise/fall variants)
  - `iIntensityTime` in sky shaders
  - buildings scaled by intensity
- **Camera:** three stacked cameras (background/glow, foreground, close). Default FOV 90. The third-person camera blends between a near and a far pose: "moving towards the first position in more intense sections." `dynamicFOV` spans 70-120, but is driven by camera *bias* (70 + 50·bias). The bias↔intensity mapping is **not documented**. The Nov 2015 update made the camera "move out farther and in closer" for "feeling of speed" ([announcement](https://steamcommunity.com/games/235800/announcements/detail/75794571741426702)). There is a swoop fly-in at song start and a fade to white at the end. **No camera-shake parameter** exists in any documentation.
- **Post-processing:**
  - Radial blur = `min(1.5, max(0, bias−0.6)·5) · (0 if jumping)`, on background objects only.
  - Glow is static (4 passes, intensity 1.5), not music-driven.
  - Bloom/dirty-lens, LUT and SSAO are available ([DBN skins](https://as2-doc.deathbynukes.com/skins.html)).
- **Performance tiers:** Q1 targets ~30 fps on Intel HD3000 at 720p. The glow camera is off below Q3.
- **Praise:** "these courses absolutely buzz with life and energy"; blocks and topography "sync up to the audio incredibly well" ([IGN](https://www.ign.com/articles/2015/05/29/audiosurf-2-review)). Corkscrews at the chorus bring "everything changing colour in a swirling rush" ([Zed](https://www.zedgamesau.net/reviews-2/audiosurf-2)).
- **Criticism:**
  - A low camera makes depth "almost impossible to judge" ([thread](https://steamcommunity.com/app/235800/discussions/0/810938082498898001/)).
  - Wakeboard grid readability is poor (IGN).
  - Flashing risks epilepsy and there are no colour-blind options ([review](https://commaeightcommaone.wordpress.com/2016/02/11/audiosurf-2-review/)).
  - Popular skins carry seizure warnings.
  - Some score-focused players prefer less flashy skins. This is anecdotal: the claim that "score players prefer minimal, high-contrast skins" was **not** supported.

---

## 2. Music analysis

Analysis runs in a Web Worker, **except decoding**: `AudioContext`/`OfflineAudioContext` are `[Exposed=Window]` only ([spec](https://webaudio.github.io/web-audio-api/)), so `decodeAudioData` (async, decoded off-thread by the browser) runs on the main thread and the channel data is copied into transferable buffers for the worker. Parameters are defined in **seconds**, because `decodeAudioData` resamples to the context rate.

GitHub Pages cannot send COOP/COEP headers, so there is **no SharedArrayBuffer and no WASM threads**. Pass data as transferable `ArrayBuffer`s instead.

Licensing: hand-port the published algorithms (librosa ISC, SuperFlux BSD, Ellis paper, BS.1770). Do **not** ship Essentia (AGPL), aubio or BTrack code (GPL), or madmom models (CC BY-NC-SA).

### 2.1 Offline (local file and demo): the "SongMap"

1. **Decode once** with the playback `AudioContext.decodeAudioData` (context rate, usually 44.1/48 kHz, stereo). **Play that same `AudioBuffer`** through an `AudioBufferSourceNode`, never an `<audio>` element, so analysis and playback share one timeline (browsers differ in MP3 encoder-delay/gapless trimming, ~25 ms). Downmix to mono and resample to 22,050 Hz in the worker (windowed-sinc, our code) for the spectral path; loudness uses the stereo buffer at its native rate (step 7).
   - **Analysis ID** = SHA-256 of the **original file bytes** + analyzer version. Do not hash decoded PCM: decoders and resamplers differ across engines, and JS `Math.exp/log/sin` are not required to be correctly rounded, so PCM and even the SongMap can differ between Chrome, Firefox and Safari. Cache the SongMap in IndexedDB under the ID. The leaderboard key is `analysisId + SongMap hash`; a score code only verifies against an identical SongMap. Quantize features (onset times to 1 ms, strengths to 1e-3) before layout generation to reduce cross-engine drift. This still fixes AS2's problem of different tracks sharing one board.
2. **STFT:** n_fft 2048, hop 512 (23.2 ms), Hann window.
3. **Onset function:** 128 mel bands → dB, then a SuperFlux 3-bin max filter across frequency, then lag-1 rectified difference with mean aggregation ([librosa onset.py](https://github.com/librosa/librosa/blob/main/librosa/onset.py), [SuperFlux](https://github.com/CPJKU/SuperFlux)). Also compute three sub-band envelopes (mel groups: low < 200 Hz, mid 200-3,200, high > 3,200) for lane and colour decisions.
4. **Peak picking** (librosa defaults, found by a large hyper-parameter search): normalize to 0-1; pre_max 30 ms, post_max 0 + 1 frame, pre_avg 100 ms, post_avg 100 ms + 1 frame, wait 30 ms, delta 0.07. Each onset gets a `strength` equal to its envelope peak value.
5. **Tempo:** windowed onset autocorrelation over 8 s (344 frames at these settings). Prior = −0.5·((log2 bpm − log2 120)/1.0)², plus `argmax(log1p(1e6·tg) + prior)`. Compute it per frame (`aggregate=None`) for a time-varying tempo.
6. **Beat grid:** Ellis DP ([paper](https://www.ee.columbia.edu/~dpwe/pubs/Ellis07-beattrack.pdf), [librosa beat.py](https://github.com/librosa/librosa/blob/main/librosa/beat.py)):
   - normalize by std
   - local score = convolve with a Gaussian (σ = period/32, window ±period)
   - `score = cum[loc] − 100·(ln(i−loc) − ln period)²` for loc ∈ [i−2p, i−p/2]
   - trim edge beats below 0.5 × RMS of the Hann(5)-smoothed beat scores
   - beats are used for **snapping and emphasis, not for placement**: blocks come only from onsets
7. **Intensity:** BS.1770 K-weighting, per channel, summed energy (not a mono downmix).
   - At 48 kHz: pre-filter b = [1.53512485958697, −2.69169618940638, 1.19839281085285], a = [1, −1.69065929318241, 0.73248077421585]; RLB b = [1, −2, 1], a = [1, −1.99004745483398, 0.99007225036621].
   - At any other rate (44.1 kHz is common) the coefficients must be recomputed. Use libebur128's rate-independent design (MIT): shelf f0 1681.974 Hz, G 3.99984 dB, Q 0.70718; high-pass f0 38.1355 Hz, Q 0.50033; `K = tan(π·f0/fs)` ([ebur128.c](https://github.com/jiixyj/libebur128/blob/master/ebur128/ebur128.c)).
   - short-term 3 s and momentary 400 ms loudness at a 100 ms hop
   - `I_raw = 0.7·ST + 0.3·M` in LUFS, floored at −70 LUFS (silence is −∞)
   - normalize per song: map the 5th → 95th percentile of frames above −70 LUFS onto 0 → 1 and clamp (this mirrors AS2's normalized intensity, but is robust to one loud spike and to long silences)
   - asymmetric one-pole smoothing: attack τ 0.35 s, release τ 1.2 s, giving `I`
8. **Track nodes** at 30 Hz: node k is at t = k/30, and the renderer uses Catmull-Rom between nodes.
   - speed `v(t) = lerp(vMin, vMax, I^1.3)`; distance is its integral (strictly monotonic, so track position is a pure function of song time and cannot drift). Our units are metres (lane spacing 3 m): Mono vMin 25, vMax 70 m/s; Casual ×0.8; Ninja ×1.26 and Ninja Turbo ×1.45 (AS2's ratios, §1.2). AS2's own units are undocumented, so these are starting values for playtests. A 4-minute song is about 8–15 km of track.
   - slope: `pitch = I<0.5 ? +10°·(0.5−I)/0.5·0.8 : −24°·(I−0.5)/0.5·1.55`, rate-limited to 12°/s, which keeps AS2's up/down asymmetry
   - yaw: low-frequency noise seeded by the analysis ID, amplitude ±15° and scaled down at high density
   - colour: `gradient(I)`
9. **Blocks:**
   - One candidate per onset. Never more blocks than onsets (Beat Saber's rule against "overmapping", [BSMG](https://bsmg.wiki/mapping/basic-mapping.html)).
   - Snap to the nearest 1/4-beat grid point if within 35 ms, otherwise keep the raw time. Avoid finer than 1/8: high-precision grids "will make your song mistimed."
   - Density caps per difficulty, applied by dropping the weakest first. AS2 has no difficulty tiers, only modes, so each mode picks a default cap (the player may override):

     | Difficulty | Max notes/s | Default for |
     |---|---|---|
     | Easy | 2.3 | Casual mode |
     | Normal | 3.4 | — |
     | Hard | 5.2 | Mono |
     | Expert | 7.8 | Ninja / Ninja Turbo |

     Each step down should cut density ≥ 20% (from the BSMG baselines). The cap counts colour blocks and greys together.
   - **Greys:** Mono's recipe (weakest 23% by strength + longest-span 5%). Ninja: 35%.
   - **Spans:** a held tone is a region after an onset where the band energy stays above 60% of the onset peak for ≥ 250 ms with low flux. `chainend` is where it falls below. Cap at 2 s.
   - **Lanes: deterministic and musical**, the key change from AS2. A seeded PRNG (analysis ID) is biased by band: low → centre-weighted, high → outer-weighted, mid → alternate. **The same sound gets the same weight** (BSMG's consistency rule: the same sound mapped with the same weight "usually", not copy-paste): repeated 8-beat onset patterns (cosine similarity of onset vectors > 0.9) reuse the lane pattern, mirrored on alternate repeats.
   - AS2's spacing rules apply unchanged (§1.2). Same-lane gap ≥ 0.12 s.
10. **Power blocks and loops:** novelty = 4 s-ahead mean of `I` minus 4 s-behind mean, plus onset-density rise. Take the top peaks with ≥ 12 s spacing, not in the first 20 s, up to `floor(minutes)+2`. Rank 1 is the big PB with a double corkscrew and the weakest gets a plain loop, as in AS2. Loops are 2.5-3 s long and centred so the PB sits at the drop.
11. **Quiet sections:** if `I` < 0.1 for more than 4 s at the start, offer to skip the intro (PULSEDRIVE does this). Mid-song quiet sections keep blocks sparse but never zero for more than 3 s: fall back to beat-grid blocks at half density.

Target (untested): a 4-minute song analysed in ≤ 3 s on a 2022 laptop, with a progress bar.

**Demo song:** synthesized with `OfflineAudioContext` from a seeded score at 128 BPM, about 2:30. Structure: intro 8 bars, build 8, drop 16, break 8, drop 16, outro 8, using kick, snare, hats, a saw bass, a pad and a lead. Keep the generator's true note times and loudness curve, and use them as a **CI fixture**: onset F-measure ≥ 0.9 at ±50 ms, BPM within ±1, and PB placed within ±0.5 s of each drop.

### 2.2 YouTube (live)

**Default path: YouTube Beat Sync.** This path never touches the audio.
- **Setup:** the user pastes a URL or ID; no Data API (so no API key to expose on a static site, no quota, no search). playerVars `enablejsapi=1`, `origin=<site>`, `playsinline=1`. Handle `onError` ([reference](https://developers.google.com/youtube/iframe_api_reference)): 101/150 = embedding disabled by the owner (common for label music; say so and ask for another video), 100 = not found/private, 153 = missing Referer, 2/5 = bad ID/HTML5 error.
- **State gating:** the run advances only in state 1 (playing). States 2/3/−1 (paused, buffering, unstarted) freeze the run and the track; state 0 ends it. Pre-roll and mid-roll ads can play in embeds and the reference says nothing about `getCurrentTime()` during ads, so start the song only after a playing state whose time is near 0, and treat any backwards or > 0.5 s jump in reported time as a seek (re-sync).
- The player stays visible. Timing comes from `getCurrentTime()`, which the widget already extrapolates locally while playing (undocumented and minified, may change; [widgetapi](https://www.youtube.com/s/player/7460dd14/www-widgetapi.vflset/www-widgetapi.js)). Smooth it further with `performance.now()` and a PLL (gain 0.1). Re-sync on `onStateChange` and seeks.
- The player taps 8+ beats (keyboard or click). Fit BPM with least squares on tap times, and take phase from the residual median. Refine with nudge keys (±1 ms, ±0.1 BPM) during play.
- The grid gives blocks on beats and off-beats by difficulty. Intensity is **not available** here, so the track shape is procedural: 16-bar phrases with builds that climb to a drop every 32 bars. The player can mark "drop" moments by tapping, and saved sync data (`videoId → bpm, offset, drops`) is human-authored.
- Honest limitation: it follows the beat, not the song's shape.

**Opt-in path: Live Listen** (desktop Chrome/Edge only; flagged "experimental, see policy note"; off by default):
- **Capture:** `getDisplayMedia({video:true, audio:{echoCancellation:false, noiseSuppression:false, autoGainControl:false, suppressLocalAudioPlayback:false}, preferCurrentTab:true})`, called from a click.
  - Stop the video track immediately.
  - Require `getAudioTracks().length > 0`. The tab-audio box is pre-checked in current Chromium source, but the user can untick it.
  - Handle `ended` (the user clicked "Stop sharing").
  - Never set `restrictOwnAudio` or `suppressLocalAudioPlayback: true`, and never delay, replay or mute the player (§5).
- **Pipeline:** MediaStreamSource → AudioWorklet that collects 512-sample hops at the context rate (~10.7 ms at 48 kHz) → transfer to the worker.
- **Onsets, causal:** frame 1024, log filterbank at 12 bands/octave from 30 Hz to 17 kHz, log(1 + X), 3-bin max filter, rectified flux. Peak picking: pre_max 30 ms, post_max 1 frame (adds 10.7 ms latency), pre_avg 100 ms, delta 0.07 against a running max normalizer with 10 s decay.
- **Tempo and phase** (BTrack-style, ported from the paper, not the GPL code):
  - onset buffer of 512 frames (~5.5 s)
  - autocorrelation → 4-harmonic comb filterbank with Rayleigh weighting peaked at 120 BPM
  - 41-state tempo HMM, 80-160 BPM in 2 BPM steps (σ = 41/8)
  - cumulative score: α 0.9, tightness 5, log-Gaussian window over [−2T, −T/2]
  - at each mid-beat, project one period ahead to predict the next beat
  - ([BTrack](https://raw.githubusercontent.com/adamstark/BTrack/master/src/BTrack.cpp), [Stark et al. DAFx-09](https://dafx.de/paper-archive/details.php?id=XiEJjIc0a2Hb_KTJon0SaA))
- **Placing blocks ahead:** the visible horizon is H = 2.0 s of travel.
  - Extrapolate the locked grid, `t_n = t_last + n·T`, out to H.
  - Place a block at a predicted beat only if confidence c > 0.6, where c = the autocorrelation peak-to-mean ratio, normalized.
  - Blocks between 1 s and 2 s ahead are "ghosts" (40% alpha). They become solid when the next observed beat lands within ±40 ms of the prediction. Otherwise they fade out and the grid re-phases: shift at most 25% of T per beat to avoid visual jumps.
  - Lanes: the sub-band energy of the *last* observed beat in the same bar position (a pattern-memory ring of 16 beats) predicts the band of future beats.
  - Greys fill beats with low predicted strength.
  - Track slope and colour follow `I` measured live and smoothed (attack 0.5 s, release 2 s), then written into nodes being generated H ahead. The resulting 2 s lag is accepted and documented.
  - No PBs or loops tied to drops, because drops cannot be predicted. Instead, award a PB after 16 bars of locked confidence.
- **Latency budget:** measured offset `Δ = captureDelay (≥ 20 ms Chromium loopback, can grow) + analysis delay (~11-22 ms) − outputLatency` ([loopback_signal_provider.cc](https://raw.githubusercontent.com/chromium/chromium/main/services/audio/loopback_signal_provider.cc), [outputLatency](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/outputLatency)). Calibrate once per session: the game plays 8 clicks, detects them in the capture, takes the median offset, and subtracts it from all onset times. The capture also contains the game's own SFX. Duck the SFX during calibration, and subtract the known SFX schedule from onset candidates (drop onsets within 30 ms of our own SFX triggers).

**Local-file sync (both modes):** schedule against `AudioContext.currentTime`. Each frame, heard song time = `ts.contextTime + (performance.now() − ts.performanceTime)/1000 − songStartCtxTime`, from `ts = getOutputTimestamp()`. `contextTime` is already "the sample frame currently being rendered by the audio output device" ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/getOutputTimestamp)), so do **not** also subtract `outputLatency` (that double-counts). Use `currentTime − outputLatency` only as a fallback while `getOutputTimestamp()` still returns zeros (before the first rendered block). Smooth the result (it jitters by one render quantum) and never let it run backwards. Bluetooth has measured ~178 ms versus ~0-25 ms wired ([jamieonkeys](https://www.jamieonkeys.dev/posts/web-audio-api-output-latency/)); browsers do not always report it, so add a user offset slider with a tap-calibration screen. Input judgments use the same corrected clock.

---

## 3. Keep / improve / drop

**Keep:**
- **Whole-song analysis driving slope, speed, density and colour.** This is the genre's identity; live-only analysis "only ever knows the current instant" ([PULSEDRIVE](https://github.com/digi-the-robot/PULSEDRIVE)).
- **Mono as the flagship**, with its exact rules: 3 lanes, 3×7 grid, 35·n², 1.5 s timer, `eraseone` greys, chainspans that pause the timer, overfill cash-in, PB ×1.5/×2 or duplication, Clean Finish +10%. These rules have proven depth, and top players plan around them.
- **Ninja** (spike = wipe, stealth +25%) and **Casual** (1.75 s timer, shoulder lanes, few PBs).
- **Corkscrew loops as visible foreshadowing** of big moments. IGN: "looking out for the tell-tale loops on the horizon."
- The results screen (raw → bonuses → final) and live ghost score against your personal best.

**Improve (browser advantages and fixes for known complaints):**
- **Deterministic, musical lanes.** AS2 re-randomizes lanes on every play, which makes practice pointless and compares different tracks on one board. Ours: layouts seeded by the analysis ID, with an opt-in "Remix" toggle.
- **Beat-true placement.** Onsets snapped to a DP beat grid, with the rule of never more blocks than sounds. This answers the oldest complaint, that the blocks "don't always follow the beat" ([GameSpot](https://www.gamespot.com/reviews/audiosurf-review/1900-6189185/)).
- **Leaderboard integrity:** the key is the file hash + SongMap hash (§2.1), not artist/title metadata. Boards are local (IndexedDB), with shareable score codes (`analysisId + songMapHash + seed + score + input-log hash`) so friends can verify by replaying; a SongMap mismatch (other engine or analyzer version) is reported as "different track", not as cheating. No server is needed, which avoids the dependency deaths of Riff Racer, Echo Nest and Spotify ([MCV](https://mcvuk.com/development-news/the-develop-post-mortem-riff-racer/), [Spotify](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api)).
- **Readability first:**
  - Hazards differ by **shape and value**: dark body, white rim, spiked geometry. Hue is not the cue, and hazards never take the highway colour (PULSEDRIVE: "colour is reserved for things worth collecting").
  - Colour-blind safe by construction.
  - A higher default camera than AS2's.
  - FOV capped at 95°, not 120°.
- **Photosensitivity:** a flash limiter allows no more than 3 flashes per second in **any** region larger than 25% of a 10° field (≈ 341×256 px at 1024×768, scaled to the viewport), not just full-field. A flash is a pair of opposing changes of ≥ 10% relative luminance where the darker state is < 0.80; **saturated-red** transitions (R/(R+G+B) ≥ 0.8) count separately and also cap at 3/s ([WCAG 2.3.1](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html)). Implement it as a per-tile (e.g. 8×6) luminance history on a 1/16-res readback of the post-bloom frame, clamping the bloom/beat-pulse gain when a tile would exceed the limit. Plus a "calm visuals" preset. Several top AS2 skins needed seizure warnings.
- **Audio juice** (Thumper-style): hit sounds are quantized to the next 1/16 of the song's beat grid and pitched per column. Match cash-in plays a chord stab. A grey hit plays a muted thud and dips the music bus −3 dB for 150 ms (local files only; never touch the YouTube player's audio).
- **Instant restart** (< 1 s, analysis cached) and **input on every device:** mouse, keyboard (hold-to-lane as in AS2), gamepad, and touch drag. Ship x is continuous and clamped to ±3 (±4.5 with shoulders); mouse/touch map absolutely across the track width (pointer lock for mouse); keyboard/gamepad hold drives the target to the outer lane and release returns to centre, with a critically damped approach that crosses one lane in ~60 ms. The collision lane is the nearest lane at the hit window (§1.2).

**Drop:**
- **Wakeboard, Pusher, Vegas, Eraser, Double Vision.** Little played, weak readability, and the puzzle numbers are unverified. Revisit **Pointman** after launch as the single puzzle mode.
- **Lua modding and the Workshop.** Replace with JSON skins (palette, geometry toggles, post settings) later.
- **SoundCloud/Spotify/online analysis APIs**, and any dependency on a server.
- **AS2's randomized lanes as the default**, and the low camera.

---

## 4. Visual and effects direction

**Palette** (linear HDR; tone-map with AgX; exposure 1.0):
- Background `#05060A`, fog `#0B0E1F` (exp2, density 0.0018: 31% left at 600 m), horizon glow band `#1A1450`.
- Intensity gradient, sampled in OKLab: 0.00 `#3A2CFF` · 0.25 `#0FA3FF` · 0.50 `#19E0A0` · 0.70 `#FFD23A` · 0.85 `#FF7A1A` · 1.00 `#FF1F4B`.
- Blocks: emissive = `gradient(I_node)` × (2.5 + 1.5·strength), so bloom picks them up.
- Hazards: albedo `#15171D`, emissive rim `#E8ECF5` × 1.2 (always below bloom threshold × 1.5), spike geometry.
- Power block: white core × 6 with a chromatic halo.
- Album-art palettes (from embedded tags) are optional. Reject a palette whose OKLab chroma is < 0.05, the greyscale problem that led AS2 to add `OverrideTrackColorForDynamicBlockColors`.

**Track shader** (one TSL material, one ribbon mesh):
- Geometry is built from the nodes in chunks of 50 m (a 4-minute song is 160-300 chunks), generated lazily in a ring of 16 pooled chunk meshes (reused buffers, no per-frame allocation), frustum-culled. Draw distance 650 m, which covers the 6-8 s loop foreshadowing at vMax 70 m/s; fog is tuned so geometry is ~70% faded at 600 m. Cross-section: 12 vertices (surface + raised rails). Vertex attributes: `songTime`, `I`, `lateral`.
- **Floating origin:** positions reach 10-60 km, where float32 steps are 1-4 mm and cause vertex/instance jitter near the camera. Each chunk stores vertices relative to its own origin, and the world is re-based around the ship every 1 km (shift chunk and instance matrices; compute them in float64 in JS).
- Surface: albedo `#0A0C14`, roughness 0.35, Fresnel rim `gradient(I)` × 0.6.
- Lane dividers at ±1.5 and shoulders at ±4.5: analytic lines (width 0.04, `fwidth` anti-aliasing), emissive `gradient(I)` × (1 + 2·I).
- Scrolling chevrons in the centre lane at 1 per beat, phase-locked to the beat grid (uniform `beatPhase`).
- Beat pulse: emissive += 0.6·exp(−Δt_beat/0.12) × (0.3 + 0.7·I).
- A "future highlight" band 0.5 s ahead marks the timing window.
- Rails: emissive `gradient(I)` × (1.5 + 2.5·I). The past track fades to 20% over 30 m behind the ship.

**Bloom and post** (half-resolution chain):
- Bloom (three `bloom()` node): threshold 1.0, radius 0.45, strength 0.55 + 0.6·I (smoothed), plus burst terms from impacts.
- Radial speed blur, 6 taps, applied only when `speed01 > 0.6`: `strength = min(1.5,(speed01−0.6)·5)·0.012`, off in loops. This is AS2's formula with speed standing in for camera bias.
- Chromatic aberration 0.0012·I², vignette 0.28, one SMAA/FXAA pass.
- No SSAO, SSR or depth of field.

**Reactive environment** (all instanced):
- **Skyline:** 1,200 instanced pillars in 3 depth bands placed along the track (every 12th node, 60-900 units out). Each instance holds band ∈ {low, mid, high}. Height = base × (1 + 2.5·E_band(t)), where E comes from precomputed 16-band energies sampled by song time. Local files only; in Beat Sync mode heights come from the beat envelope.
- **Rings:** at the top 18% most intense nodes, as instanced torus quads; they flash on beats.
- **Air debris:** 4k GPU points on a wrap-around volume that flash on block hits (as in AS2).
- **Skywires:** 6 instanced line strips.
- **Sky:** full-screen gradient plus a starfield whose drift phase = ∫I dt (AS2's `iIntensityTime`).
- **Loops:** visible 6-8 s ahead, with their spiral rails pre-lit at 30% so they read as foreshadowing.

**Camera:**
- Chase camera on a critically damped spring (ω = 6 rad/s).
- Calm pose: offset (0, 4.6, −7.5), pitch 21°. Intense pose: (0, 3.2, −5.2), pitch 17°. Blend by smoothed I.
- FOV 72 → 92 with I, rate-limited to 20°/s. Strafe factor 0.5, banking 0.4 × lateral velocity (max 8°).
- A small upward tilt of the track ahead (Thumper: helps "see all the obstacles much clearer").
- Swoop-in 2 s before the song starts. The song starts only after the swoop, which fixes the AS2 complaint of hitting blocks before seeing them.

**Impact juice** (budget: all effects pooled, all ≤ 250 ms):
- **Block hit:** 12 instanced shards (from a pool of 256), ship emissive flash for 80 ms, grid cell pop 1.25 → 1 over 120 ms with ease-out-back, camera kick −0.08 m on the spring, bloom +0.25 decaying over 150 ms, debris flash, quantized pitched SFX.
- **Match cash-in:** a shockwave ring travels down the track, count-up tween over 400 ms, grid cells burst in cascade (20 ms stagger), and a hit-stop is **not used** (the music cannot pause).
- **Grey hit:** desaturate to 40% for 150 ms, low thud, 0.04 m shake (off by default), top grid cell cracks.
- **Power block:** FOV +8° punch over 300 ms, bloom +0.6, radial blur at max during the loop entry, ×1.5/×2 badge.
- **Overfill warning:** the column rim pulses at 2 Hz in orange-red `#FF5A2A` (R/(R+G+B) < 0.8, so not a WCAG "saturated red"), on a HUD element well under the flash-area threshold. A 4 Hz red pulse would be 4 flashes/s.

**Performance budget** (target 60 fps at 1080p on Intel Iris Xe or UHD 620-class):
- **GPU ≤ 11 ms, CPU ≤ 4 ms per frame.** Dynamic resolution 0.6-1.0, driven by the GPU timestamp query where available, otherwise by the frame-time EMA.
- **Draw calls ≤ 60** in the main pass: track chunks ≤ 14 visible, blocks 1, hazards 1, shards 1, pillars 1, rings 1, debris 1, sky 1, ship ≤ 4, grid HUD 2. Plus ≤ 14 post passes.
- **Triangles ≤ 350k** visible. Instance caps: blocks 512, hazards 256, shards 256, pillars 1,200.
- **Memory:** GPU ≤ 192 MB (no textures over 1K except the gradient LUT, 256×1), JS heap ≤ 120 MB with the SongMap included (a 10-minute song at 30 Hz nodes is about 18k nodes × 16 floats ≈ 1.2 MB). The decoded **playback `AudioBuffer` is the largest cost and sits outside that budget**: float32 stereo at 48 kHz is ~23 MB per minute (4 min ≈ 92 MB, 15 min ≈ 345 MB), plus transient copies during decode and transfer. Transfer, never clone, to the worker; free the file `ArrayBuffer` and the 22 kHz mono copy after analysis; lower the length cap to 10 minutes on devices reporting `navigator.deviceMemory` ≤ 4.
- **Shader compile hitches:** TSL pipelines compile on first use (worst on the WebGL2 backend). Call `await renderer.compileAsync(scene, camera)` with every material, including the PB and burst variants, during the loading screen, before the swoop.
- **High-refresh displays:** `setAnimationLoop` runs at the display rate, so on 120-144 Hz screens the budget is 7-8 ms. Dynamic resolution handles it; do not skip frames to fake 60 Hz (judder).
- **Zero allocation per frame:**
  - Pre-allocated `Float32Array`s for instance data, with a `setUsage(DynamicDrawUsage)` range update of only the changed segment.
  - Scratch `Vector3`/`Matrix4` at module scope; no closures, spreads or arrays in the frame loop; event objects pooled.
  - Audio clock read into a reused struct.
  - Acceptance: a Chrome performance trace of a full 4-minute song shows **no minor GC** and no long task over 8 ms.
- **Render loop:** analysis work stays in the worker; the main thread only renders. Frame pacing comes from `renderer.setAnimationLoop`. Game logic runs at a fixed 240 Hz substep keyed to audio time, interpolated for render.
- **Fallback tier:** WebGL2 backend (or when the tier auto-detects low); bloom quarter-res, no chromatic aberration or radial blur, pillars 400, debris 1k.

---

## 5. YouTube constraints (verbatim; all pages last updated 2026-09-14)

From the [Developer Policies](https://developers.google.com/youtube/terms/developer-policies), under "You and your API Clients must not, and must not encourage, enable, or require others to:"
- "use any technology other than YouTube API Services to access or retrieve API Data, including to access any portion of any YouTube audiovisual content;" (III.I). "API Data" includes "data, content (including audiovisual content)" (IV).
- "separate, isolate, or modify the audio or video components of any YouTube audiovisual content … For example, you must not apply alternate audio tracks to videos;"
- "modify, build upon, or block any portion or functionality of a YouTube player;"
- "create, include, or promote features that play content, including audio or video components, from a background player, meaning a player that is not displayed in the page, tab, or screen that the user is viewing;"
- "download, import, backup, cache, or store copies of YouTube audiovisual content without YouTube's prior written approval" (III.E.1.a)
- "Your API Clients must not … (ii) access or use API Data to create new or derived data or metrics." (III.E.4.h)

From the [Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality):
- "Embedded players must have a viewport that is at least 200px by 200px." (Recommended: 480×270 for 16:9.)
- "You must not display overlays, frames, or other visual elements in front of any part of a YouTube embedded player, including player controls."
- "You must not make changes to the YouTube player that are not explicitly described by the API documentation."
- "an API Client must not initiate an automatic playback until the player is visible and more than half of the player is visible on the page or screen."
- Players must identify themselves through the HTTP Referer header. GitHub Pages sends no Referrer-Policy that would block it.

Obligations that apply to any API Client, including one that only embeds the player (same Developer Policies page; wording from a fetch summary, re-check the exact text before launch):
- **Privacy policy:** "Each API Client must require users to agree to a privacy policy before users can access the API Client's features". It must "notify users that the API Client uses YouTube API Services", "reference and link to the Google Privacy Policy", and explain what user information is accessed, collected and stored, plus a contact for complaints.
- **Terms:** "API Clients must display a link to YouTube's Terms of Service" and state in their own terms that users agree to be bound by them.
- **Attribution/branding:** pages showing YouTube content "must make clear to the viewer that YouTube is the source" and follow the YouTube Branding Guidelines. Do not put "YouTube" in the game or mode name; label the mode descriptively ("Play along with a YouTube video").
- **Storage limits:** Authorized and Non-Authorized API Data may be kept no longer than 30 calendar days; video IDs are not explicitly exempted. Our own tap data is not API Data, but keying it by `videoId` for longer may count as storing API Data (risk 1).

The [YouTube ToS](https://www.youtube.com/t/terms) forbid users to "access, reproduce, download … alter, modify or otherwise use any part of the Service or any Content except: (a) as expressly authorized by the Service; or (b) with prior written permission from YouTube".

**Design rules that follow:**
- The player sits in its own docked panel at ≥ 480×270, **never under the WebGPU canvas or any HUD**. The canvas is laid out beside it, not over it. The widget reports visible fraction and ancestor origins to YouTube, so hiding it is detectable.
- Autoplay starts only after the player is ≥ 50% visible. Control goes only through documented API calls.
- No audio downloading or caching, no delay/replay of captured audio, no muting the player to substitute our own playback, no background player, no hidden or tiny player.
- **Beat Sync** uses only documented timing plus human taps, so no audio is accessed. It is the default YouTube mode.
- **Live Listen** reads captured tab audio. Read plainly, that conflicts with the "any technology other than YouTube API Services … to access any portion" clause, and arguably with "isolate" and "derived data". No official guidance or enforcement case was found. Ship it behind an explicit opt-in with that disclosure, keep audio in memory only, never store or send it, **or leave it out until YouTube API support or counsel clears it** (recommended for a public portfolio). Precedent: Audioshield and AS2 both lost YouTube streaming in June 2018 ([Steam](https://steamcommunity.com/app/412740/allnews/)). "License policy" is the reported reason, not a confirmed one.

---

## 6. Open risks

1. **Policy (highest):** Live Listen may be judged a III.I violation. Mitigation: default off or excluded; Beat Sync is the shipped YouTube mode. Whether saved `videoId → bpm/offset/drops` sync data counts as "derived data" is unconfirmed. It is human-authored, so probably outside the clause, but keeping the `videoId` key beyond 30 days may hit the storage limit; either refresh it (re-validate the ID through the player) within 30 days or let the user export/import sync files instead of us storing them. The privacy-policy, ToS-link and attribution duties apply even to Beat Sync.
2. **Live prediction quality:** BTrack-style trackers really predict only about half a beat ahead. Anything further is constant-tempo extrapolation. Tempo changes, rubato and beatless music will produce ghost blocks that never solidify. Needs play-testing on 20+ genres. Octave errors (half/double BPM) need a user ×2/÷2 toggle.
3. **Latency variance:** the Chromium loopback delay can grow mid-session, Bluetooth adds ~180 ms, and there is no published end-to-end measurement. Calibration may drift. Re-run the click calibration if the onset-vs-prediction residual median drifts > 25 ms.
4. **Unverified AS2 numbers** in any we copy: Casual 1.75 s / Ninja 1.5 s timers, Ninja stealth 25%, Ninja `eraseall`, puzzle coefficients. Mono's numbers are solid (script + 2 guides). Treat the rest as tunable, not canon.
5. **The intensity model is ours, not AS2's:** AS2's intensity formula, node rate and speed units are undocumented. Tuning targets (slope range, vMin/vMax, FOV) need playtests against the feel of AS2 videos.
6. **Browser platform:** WebGPU availability and driver variance on integrated GPUs; the WebGL2 fallback must hit the same gameplay. No SharedArrayBuffer on GitHub Pages. Only Chromium desktop gives tab audio. Safari `outputLatency` needs 18.4+.
7. **YouTube widget internals:** `getCurrentTime` local extrapolation comes from undocumented minified code and can change. Keep our own PLL smoothing.
8. **Analysis cost on long files:** 10+ minute tracks at 22.05 kHz STFT in a single worker without threads. Chunk the work and stream progress; cap at 15 minutes.
9. **Cross-browser determinism:** the same file can decode and analyse slightly differently in Chrome, Firefox and Safari (decoder trimming, resampling, non-correctly-rounded `Math` functions). Boards and score codes are therefore keyed to the SongMap hash; CI should run the demo fixture in all three engines and report SongMap diffs.
10. **Embeddability:** many label-owned music videos return error 101/150 in embeds, which limits Beat Sync's catalogue. Ads before or during a video pause the run.
11. **Deterministic layouts vs. replay value:** AS2's randomness had fans. The "Remix" toggle keeps it, but boards stay per-seed.
12. **Photosensitivity compliance** of the 3-flashes/s limiter is a design rule, not a certified test. Validate with a PEAT-style analyzer on recorded gameplay.
