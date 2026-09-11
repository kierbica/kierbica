# ULTIMATE 1-MINUTE TRADINGVIEW PINE SCRIPT v6 TRADING SYSTEM
## Research-Driven, Non-Repainting, Risk-Aware, Overfitting-Resistant Buy/Sell Signal Oscillator + Strategy

| | |
|---|---|
| **Files** | `src/ultimate_1m_oscillator.pine` (Version A — indicator) · `src/ultimate_1m_strategy.pine` (Version B — strategy) · `tools/pine_sanity_check.py` (static linter) |
| **Language** | Pine Script™ v6 |
| **Primary timeframe** | 1 minute (with confirmed 15-minute bias context) |
| **Status** | Research framework. **No backtest results are claimed or implied.** All performance evidence must be produced by you, using the protocol in Part 10. |
| **Disclaimer** | Nothing here is financial advice. Historical or hypothetical performance does not guarantee future results (see CFTC Regulation 4.41(b)(1)(i) on the limitations of hypothetical/simulated results: they are prepared with hindsight and cannot fully account for liquidity, slippage, spreads, and execution realities). |

**An honesty note before anything else.** This deliverable deliberately does **not** contain equity curves, win rates, profit factors, or any other performance numbers, because running the required multi-symbol, out-of-sample, walk-forward validation inside TradingView was not possible from this environment and fabricating results would violate the core objective of this project. What you receive instead is (a) a system whose every design choice is justified by evidence or explicit reasoning, (b) a falsifiable validation protocol with pass/fail gates, and (c) the explicit statement required by Part 34 of the brief: **if your validation fails the gates, the correct conclusion is "no sufficiently robust edge was demonstrated" for that market and period.** A 1-minute system whose edge survives realistic costs is rare; treat absence of proof accordingly.

---

# PART 1 — EXECUTIVE SUMMARY

**What was built.** A hierarchical, regime-switching signal system for 1-minute charts, delivered as two synchronized Pine v6 files: an **oscillator/signal indicator** (composite score, regime panel, markers, alerts) and a **strategy** (identical signal core + ATR bracket orders, break-even, trailing, time-stop, session-flat, configurable sizing and costs). The signal core is code-identical between the files (enforced automatically by the linter), so indicator and strategy cannot silently disagree — a common failure mode in two-file systems.

**What the signal represents.** The oscillator is a bounded composite score in **[−100, +100]** built from six **ATR-normalized, bounded components**: EMA spread, EMA slope, momentum, RSI position, Bollinger band position, and Parabolic SAR state. The score is **regime-weighted**: in trending conditions it behaves as a momentum/continuation oscillator; in ranges it blends toward a mean-reversion reading; in the ambiguous "transition" band it is suppressed by default. A signal is the event of the score **crossing ±30 at bar close**, in the regime-permitted direction, passing quality gates (volatility band, bandwidth floor, cost-vs-ATR proxy, session, cooldown, candle + momentum-turn confirmation, confirmed higher-timeframe bias).

**Intended market regime.** Volatile-enough, liquid, low-cost 1-minute markets: major crypto pairs, liquid FX majors during active sessions, index futures CFDs during RTH. It is explicitly **not** designed for dead low-volatility tape (gated out), panic conditions (gated out), or illiquid instruments (cost gate rejects them).

**What makes it different from "RSI < 30 + BB touch = buy."**
1. **Redundancy-aware design.** RSI, momentum, and band position all encode overlapping short-horizon mean-reversion information; EMA spread/slope/SAR all encode trend information. The architecture accounts for this: components are grouped by *information class*, momentum is used mainly as a **turn-confirmation gate** (not a level), standard deviation enters only through the band/BBW terms (never separately), ATR is **never directional** (only normalization/regime/risk), and PSAR carries the smallest weight with an explicit note that ablation (Part 10, Stage 2) may justify removing it.
2. **Regime-switching score** instead of one fixed rulebook — the same score line re-interprets itself between trend and range modes, with a neutral transition buffer that suppresses trading.
3. **Non-repainting by construction**: every signal is a bar-close event; the single higher-timeframe request uses TradingView's documented confirmed-data pattern; `alert()` calls are additionally gated on `barstate.isconfirmed`.
4. **Microstructure honesty**: Pine cannot observe the live bid/ask spread — the system says so and uses a conservative tick-based cost proxy that *rejects trades whose stop distance or ATR is small relative to your assumed spread/slippage*.
5. **Simplicity bias**: ~30 exposed inputs is already a lot of degrees of freedom; the protocol in Part 10 exists to punish, not reward, that complexity if it does not earn its keep out-of-sample.

**Major limitations.** (i) No demonstrated profitability yet — the framework is falsifiable, not proven. (ii) TradingView's broker emulator makes intrabar fill assumptions (open→high→low→close path) that can materially flatter or penalize 1-minute stop/target fills; stress testing and `use_bar_magnifier` (Premium) mitigate but don't eliminate this. (iii) Pine cannot model order-book depth, latency, partial fills, or live spreads. (iv) Six components and ~12 core thresholds are a wide search space; without walk-forward discipline, any parameter set can be curve-fit. (v) Signal delay of one bar (close → next open) is unavoidable for non-repainting discipline and is *by design* — it is the cost of honest signals.

---

# PART 2 — RESEARCH FINDINGS

## 2.1 Evidence base and citations

**Official documentation (highest priority):**
- Pine Script v6 introduction and strict-boolean/lazy-operator/dynamic-request semantics — TradingView release notes: <https://www.tradingview.com/pine-script-docs/release-notes/> ("Introducing Pine Script v6", Nov 2024: bools are strictly true/false; `and`/`or` short-circuit; all `request.*()` can execute dynamically).
- v6 migration guide (bool can no longer be `na`; `na()`/`nz()`/`fixnan()` no longer accept bools; int/float no longer implicitly cast to bool): <https://www.tradingview.com/pine-script-docs/migration-guides/to-pine-version-6/>
- Repainting — "Historical vs realtime calculations", the `request.security()` repaint trap, and the future-leak warning for `lookahead_on` without offset: <https://www.tradingview.com/pine-script-docs/concepts/repainting/>
- Other timeframes and data — the **only** recommended non-repainting HTF pattern (`expression[1]` + `lookahead = barmerge.lookahead_on`): <https://www.tradingview.com/pine-script-docs/concepts/other-timeframes-and-data/>
- PineCoders' "Higher-timeframe requests" (independent corroboration of the same pattern): <https://www.tradingview.com/script/W1YpYcOI-Higher-timeframe-requests/>

**Academic / quantitative literature:**
- Park, C.-H. & Irwin, S. H. (2007), *What do we know about the profitability of technical analysis?* Journal of Economic Surveys 21(4), 786–826. <https://doi.org/10.1111/j.1467-6419.2007.00519.x> — large survey: early studies often found TA profits but suffer serious methodological defects (data snooping, no out-of-sample, optimistic cost assumptions); post-2000 studies with better data and realistic costs find profitability much less often and less persistently. **Consequence for this project: TA edges at any frequency are fragile; at 1 minute they are mostly transaction-cost-limited.**
- Brock, W., Lakonishok, J. & LeBaron, B. (1992), *Simple technical trading rules and the stochastic properties of stock returns*, Journal of Finance 47(5), 1731–1764 — classic evidence that MA-based rules had predictive content on DJIA data 1897–1986, with known data-snooping caveats; the modern literature that followed is far more skeptical out-of-sample.
- Moskowitz, T., Ooi, Y. H. & Pedersen, L. H. (2012), *Time series momentum*, Journal of Financial Economics 104(2), 228–250 — document persistent multi-month/multi-week trend-following premia across asset classes. Justification for the **trend-mode** interpretation of the score (though at far lower frequencies than 1m; this is a prior, not a proof).
- Moreira, A. & Muir, T. (2017), *Volatility-managed portfolios*, Journal of Finance 72(4), 1985–2012 — scaling risk down when volatility is high improved Sharpe ratios for many equity strategies; **however**, the follow-up literature (e.g., *On the performance of volatility-managed portfolios*, Journal of Financial Economics 2020: <https://www.sciencedirect.com/science/article/abs/pii/S0304405X2030132X>) shows the real-time, out-of-sample benefit is much weaker than in-sample, and Man Group's multi-asset study (<https://www.man.com/insights/the-impact-of-volatility-targeting>) finds volatility scaling helps risk assets mainly through its implicit short-term trend exposure. **Consequence: our ATR/BBW gates are treated as risk controls first and edge sources second — and their value must be verified by ablation, not assumed.**
- Bailey, D. H., Borwein, J., López de Prado, M. & Zhu, Q. J. (2015), *The Probability of Backtest Overfitting*, Journal of Computational Finance. <https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253> — ordinary hold-out is unreliable for backtests; proposes Combinatorially Symmetric Cross-Validation (CSCV) to estimate the Probability of Backtest Overfitting (PBO). Adopted in Part 10 (Stage 6/9).
- López de Prado, M. (2018), *Advances in Financial Machine Learning*, Wiley — backtest overfitting, walk-forward discipline, why Sharpe alone is insufficient.
- CFTC Regulation 4.41(b)(1)(i) — hypothetical/simulated performance "do not represent actual trading," may over/under-compensate for liquidity and other market factors, and are "designed with the benefit of hindsight." The cost-sensitivity analysis in Part 10 (Stage 8) exists because of this class of warning.

**Practitioner sources (methodologically defensible):**
- Ernest P. Chan (*Quantitative Trading*, 2008; *Algorithmic Trading*, 2013) — mean-reversion vs momentum regime split; transaction-cost awareness at intraday horizons.
- Robert Carver (*Systematic Trading*, 2015) — position sizing by constant risk (the "risk-per-trade %" model used here), simple rules, robustness over optimization.

## 2.2 Component-by-component role determination

| Component | Information class | Used for | Why / evidence | Redundancy handling |
|---|---|---|---|---|
| **EMA fast/slow (21/55)** | Trend state | Bias (Layer B) + score `cTrend` + regime strength | MA-rule profitability is the longest-studied TA effect (Brock et al. 1992; Park & Irwin 2007); at 1m this is a fragile but real prior | Primary trend carrier. BB mid-band (SMA20) intentionally *reuses* the BB basis — no third MA added |
| **MA slope (slow EMA, ATR-normalized)** | Trend strength/health | Regime weight `trendMix`, score `cSlope` | Distinguishes "trending" from "drifting"; slope-in-ATR-units is scale-free | Partially redundant with EMA spread; kept at half weight for regime detection robustness |
| **RSI (14)** | Normalized momentum / mean-reversion extremity | Score `cRsi`; contrarian in RANGE mode, momentum-alignment in TREND mode | RSI is a bounded transform of smoothed momentum — high overlap with raw momentum (Wilder 1978) | Not allowed to double-count with momentum: momentum's *level* is down-weighted (`wMom=0.5`), its *turn* is the confirmation gate |
| **Momentum (10)** | Raw short-horizon return | Confirmation gate `mom > mom[1]` (turn) + small score weight | Turn evidence is timing information distinct from level evidence; level is nearly redundant with RSI | Deliberate demotion to a gate — this is the main anti-redundancy decision |
| **Bollinger Bands (20, 2σ)** | Price dispersion / location | Score `cBand`; BBW percentile for squeeze/chop regime | Band position normalized by σ is a clean bounded location measure (Bollinger 2001) | Stdev is **not** added as an independent indicator — it enters only via `cBand` and BBW (mathematically the same σ) |
| **Standard deviation (20)** | Volatility | *Only* inside BB construction and BBW | Perfectly collinear with BB by construction; equal-weighting both would be double counting | Explicitly excluded as a separate score input |
| **ATR (14)** | Absolute volatility | Normalization denominator for all components; regime percentile; stop/target/trail sizing | Volatility-proportional stops and ATR-normalization are standard robust-practice (Carver 2015); vol-scaling evidence is mixed OOS (see above) → treated as risk control, not alpha | ATR is never directional — no double counting with trend terms |
| **Parabolic SAR (.02/.02/.2)** | Trailing trend state | Binary `cSar`, lowest weight | SAR is essentially a trailing-stop state machine over price → almost the same information as the EMA relation | Weight 0.3/4.35 ≈ 7% of trend-mode score; **set weight to 0 and re-test in ablation**; removal is expected to be neutral-to-positive |
| **HTF EMA (15m, 50) — confirmed** | Context / higher-level trend | Bias blocker against the last confirmed 15m trend | Aligning with higher-timeframe direction is a standard robustness filter; must be confirmed data or it repaints | Not a score component — a hard directional veto, kept separate so it can be ablated cleanly |

## 2.3 Key findings and rejected approaches

- **Rejected: equal-weight sum of all 7 indicators.** RSI+momentum+band-position are one information class; EMA+SAR are another; stdev+ATR are a third. Equal weighting would triple-count mean reversion and double-count trend.
- **Rejected: RSI divergence detection.** Classic divergence needs pivots; pivot confirmation inherently references *future* bars relative to the pivot point, and the clean non-repainting version (confirmed-pivot logic) lags by the pivot half-width — on 1-minute bars this lag destroys the effect it tries to capture. TradingView's repainting documentation explicitly warns about pivot-based lookback behavior.
- **Rejected: unconfirmed HTF data.** `request.security(...)` without the `[1]`+`lookahead_on` pattern returns the *developing* HTF value in real time and repaints after reload — documented in the TradingView manual. Our HTF filter uses the documented confirmed pattern only.
- **Rejected: fixed tick/percent stops.** ATR-relative stops are the default because 1m volatility varies by an order of magnitude across sessions; fixed stops would make risk wildly regime-dependent. (ATR stops are still configurable — a user can ablate them.)
- **Rejected: signal-on-tick / intrabar entries.** Emulator intrabar assumptions make intrabar entries on unconfirmed bars unrealistic and repaint-prone. Bar-close signals + next-open fills are the honest choice.
- **Adopted with caution (must survive ablation): regime-switching score blend.** The trend/range duality is well-supported conceptually (Chan 2013; time-series momentum literature), but every extra regime state adds degrees of freedom. The transition buffer is deliberately conservative: when regime evidence is contradictory, the system stands down.

## 2.4 Major risks (explicit)

1. **Transaction costs are the primary enemy at 1m.** Park & Irwin (2007) found TA profitability largely evaporates under realistic costs; our cost-gate and stress protocol attack exactly this.
2. **Emulator intrabar assumptions** can overstate results (e.g., a bar whose range spans both stop and target).
3. **Overfitting** — see Bailey et al. (2015); combated by the staged protocol, perturbation tests, and PBO.
4. **Regime flip-flopping** around the trend/range boundary can whipsaw; cooldown + transition buffer mitigate.
5. **Data quality at 1m** (missing bars, exchange outages, bad ticks) — the system uses standard series; no attempt is made to repair bad data, and results on thin symbols should be distrusted.

---

# PART 3 — SYSTEM ARCHITECTURE

```
MARKET DATA (1m OHLCV, bar-close evaluated)
   │
   ▼
LAYER A — REGIME DETECTION
   ├─ trendMix = clamp(|cTrend| + |cSlope|, / trendDiv)      → TREND / RANGE / TRANSITION
   ├─ ATR percentile (rolling 200)                            → LOW VOL / NORMAL / HIGH VOL
   └─ BB-width percentile (rolling 200)                       → SQUEEZE flag
   │
   ▼
LAYER B — DIRECTIONAL BIAS
   ├─ Trend mode: sign of EMA spread (cTrend)
   ├─ Range mode: both directions permitted (mean reversion)
   └─ HTF veto: price vs CONFIRMED 15m EMA (blocks counter-HTF trades)
   │
   ▼
LAYER C — SETUP (implicit in the score)
   ├─ TREND mode  : score behaves as continuation/momentum oscillator
   │                (pullback-resumption = score crossing back above threshold)
   └─ RANGE mode  : score behaves as mean-reversion oscillator
                    (stretched band/RSI unwinding = score crossing threshold)
   │
   ▼
LAYER D — CONFIRMATION (independent evidence)
   ├─ Candle confirmation: close on the signal side of open AND of bar mid-point
   └─ Momentum turn: mom > mom[1] (buys) / mom < mom[1] (sells)
   │
   ▼
SCORE — normalized composite ∈ [−100, +100], regime-weighted
   │
   ▼
LAYER F — QUALITY FILTER (all must pass)
   ├─ warm-up complete · not TRANSITION regime
   ├─ ATR percentile ∈ [min, max] · BBW percentile ≥ floor
   ├─ cost proxy: ATR ≥ k₁·spread AND stop-distance ≥ k₂·spread
   ├─ session open (if enabled) · cooldown elapsed
   └─ score crossing ±entryScore AT BAR CLOSE (Layer E trigger)
   │
   ▼
ENTRY — BUY / SELL signal (confirmed at bar close)
   │
   ▼
RISK MANAGEMENT (separate module)
   ├─ qty = equity·risk% / (ATR·stopMult), capped by max leverage
   ├─ bracket at signal time: stop = entry ∓ ATR·stopMult, target = R·rrRatio
   └─ break-even at +1R · ATR trail after +1R · optional time stop
   │
   ▼
EXIT — stop / target / score-fade / opposite signal / time / session-end
   │
   ▼
ALERT — alertcondition() + confirmed-bar alert() with structured JSON payload
```

---

# PART 4 — MATHEMATICAL SPECIFICATION

All series are evaluated on bar close. `clamp(x, a, b) = min(max(x, a), b)`.

**Base indicators.**
- `RSI = WilderRSI(close, 14)`; `basis = SMA(close, 20)`; `σ = stdev(close, 20)`; `upper/lower = basis ± 2σ`
- `EMA_f = EMA(close, 21)`, `EMA_s = EMA(close, 55)`, `ATR = WilderATR(14)`, `mom = close − close[10]`, `PSAR(0.02, 0.02, 0.2)`

**Bounded, scale-free components** (each ∈ [−1, +1]; ATR-normalization makes them comparable across symbols and regimes):

| Component | Formula |
|---|---|
| `cTrend` | `clamp((EMA_f − EMA_s) / ATR, −1, 1)` — 1 unit = 1 ATR of EMA separation |
| `cSlope` | `clamp((EMA_s − EMA_s[5]) / (5·ATR), −1, 1)` — ATRs of drift per bar |
| `cMom` | `clamp(mom / ATR, −1, 1)` |
| `cRsi` | `clamp((RSI − 50) / 25, −1, 1)` |
| `cBand` | `clamp((close − basis) / (2σ), −1, 1)` — ±1 at the bands |
| `cSar` | `+1` if PSAR below price else `−1` |

**Regime engine.**
- `trendMix = clamp((|cTrend| + |cSlope|) / 1.6, 0, 1)`
- TREND mode: `trendMix ≥ 0.50` · TRANSITION: `0.35 ≤ trendMix < 0.50` · RANGE: below
- `atrPct = 100·(ATR − min(ATR,200)) / (max(ATR,200) − min(ATR,200))` (range-position rank); `bbwPct` likewise on `BBW = 4σ/basis`
- Volatility states: SQUEEZE if `bbwPct ≤ 15`; HIGH VOL if `atrPct ≥ 80`; LOW VOL if `atrPct ≤ 25`

**Composite score.** Two interpretations, blended by regime weight `m = trendMix`:

```
sTrend = wT·cTrend + wSl·cSlope + wM·cMom + wR·cRsi + wB·cBand + wP·cSar
sRange = −wR·cRsi − wB·cBand
score  = 100 · [ m·sTrend + (1−m)·sRange ] / [ m·(wT+wSl+wM+wR+wB+wP) + (1−m)·(wR+wB) ]
```
Default weights: `wT=1.0, wSl=0.5, wM=0.5, wR=0.7, wB=0.6, wP=0.3`. Score ∈ [−100, +100] by construction (weights non-negative; components bounded).

**Confidence (uncalibrated).** `conf = Σᵢ wᵢ·1[sign(cᵢ) = sign(score)] / Σ wᵢ` over all six components → 0–100%. This is an *agreement ratio*, deliberately not presented as a probability: it has not been calibrated against realized outcomes (calibration would require the validation protocol first).

**Signal definition (BUY; SELL symmetric).**
```
buySig = warmupdone ∧ ¬TRANSITION ∧ biasLong ∧ htfLong
       ∧ crossover(score, +30)
       ∧ candleUp ∧ momTurnUp
       ∧ 20 ≤ atrPct ≤ 95 ∧ bbwPct ≥ 10
       ∧ ATRticks ≥ 3·spreadTicks ∧ stopTicks ≥ 5·spreadTicks
       ∧ inSession ∧ (barsSinceLastSignal ≥ 5)
```
The signal is final **at bar close** of the signal bar; the strategy's market order fills at the **next bar open** ± `slippage` ticks − commission.

**Risk model.**
- `stopDist = ATR·1.5` (at signal close), `target = 1.5·stopDist` (R:R 1.5)
- Break-even: after price travels `≥ 1R`, stop → `entry + 1 tick` (long)
- Trail: after `≥ 1R`, stop → `max(stop, close − 2·ATR)` (long); ratcheting only
- `qty = equity·0.5% / stopDist`, capped at `equity·maxLev / price`; rejected if `qty ≤ 0`

---

# PART 5 — PINE SCRIPT v6 INDICATOR

**Authoritative source file: [`src/ultimate_1m_oscillator.pine`](src/ultimate_1m_oscillator.pine)** (≈320 lines, Pine v6, self-contained).

Why a separate file instead of pasted code here: the signal core must stay code-identical with the strategy (verified automatically by `tools/pine_sanity_check.py`) (Part 16/6 of the brief requires the two implementations never silently disagree). Keeping one authoritative copy per version prevents documentation drift. The file is fully commented.

Summary of its structure: declaration (`indicator()`, `overlay=false`) → 8 input groups → helper functions (`f_clamp`, `f_rank`) → base series → confirmed HTF request → components → regime → score → confidence → confirmations → cost/session gates → triggers → oscillator UI (score columns, smoothed line, threshold hlines, signal triangles, regime background, 8-row info table) → alerts (`alertcondition()` × 7 + confirmed-bar `alert()` with JSON payload).

---

# PART 6 — PINE SCRIPT v6 STRATEGY

**Authoritative source file: [`src/ultimate_1m_strategy.pine`](src/ultimate_1m_strategy.pine)** (≈380 lines, Pine v6, self-contained).

Identical SIGNAL CORE block (code-identical; verified by the linter), plus:

- `strategy()` declaration with **conservative defaults**: 0.05% commission per side, 2 ticks slippage, `pyramiding=0`, `calc_on_every_tick=false`, `process_orders_on_close=false` (fills at next open), 100% margin (cash-backed; lower only together with the Max-leverage input), `use_bar_magnifier=false` (enable on Premium for finer intrabar fill assumptions).
- Position sizing module (risk-% with leverage cap, or fixed qty; guards against zero/negative stop distance, oversized notional, division by zero).
- Bracket management: stop/target set **at signal time** (protects from the fill bar onward), ratcheting break-even and ATR trail on confirmed bars, optional time stop, score-fade exit, session-end flatten, automatic reversal on opposite signal.
- Order-fill `alert_message`s and the same structured `alert()` payloads.

**Broker-emulator assumptions you must understand** (TradingView strategies documentation): simulated fills assume a specific intrabar price path (open → high → low → close on the bar); when a bar could hit both stop and target, the result depends on that assumption — this is exactly where 1-minute backtests most often lie. Mitigations: enable `use_bar_magnifier` (Premium), keep targets ≥ ~1.2R, stress-test (Part 10 Stage 8), and treat single-bar-range stop+target collisions with suspicion.

---

# PART 7 — CONFIGURATION GUIDE

### Declaration-level costs (strategy, edit in code — Pine requires constants there)

| Setting | Default | Guidance |
|---|---|---|
| `commission_value` | 0.05 (%/side) | Crypto taker 0.02–0.10; FX ~0.7 pip ≈ 0.005–0.01% on majors; index CFDs per broker. **Test 2× your realistic value** |
| `slippage` | 2 ticks | At least 1 tick; 2–3 for fast markets or market orders |
| `initial_capital` | 25,000 | Set to your intended account |
| `margin_long/short` | 100 | Keep 100 for spot-like testing; lower only with the Max-leverage input |

### Inputs (both files unless noted)

| Group | Input | Default | Meaning / recommended range |
|---|---|---|---|
| Core | RSI length | 14 | 10–21; shorter = noisier, more trades |
| Core | Bollinger length / mult | 20 / 2.0 | 20/2 is standard; 1.5–2.5 mult |
| Core | Fast/Slow EMA | 21 / 55 | Slow in 40–100; ratio ~1:2.6 |
| Core | Momentum length | 10 | 5–20; gate-only role |
| Core | ATR length | 14 | 10–20 |
| Core | PSAR start/inc/max | .02/.02/.2 | Standard; weight likely 0 after ablation |
| Regime | Trend divisor | 1.6 ATR | 1.2–2.2; higher = harder to call "trending" |
| Regime | Trend threshold / transition lo | 0.50 / 0.35 | Keep a ≥0.1 neutral band |
| Regime | ATR & BBW percentile lookbacks | 200 | 100–400; ≥ half a typical session |
| Regime | vol high/low, squeeze thresholds | 80/25/15 | 75–90 / 15–30 / 10–20 |
| HTF | use / timeframe / EMA len | on / 15m / 50 | TF ∈ {5m, 15m, 30m, 1h}; must exceed chart TF (guarded) |
| Score | weights (trend, slope, mom, RSI, band, SAR) | 1.0, 0.5, 0.5, 0.7, 0.6, 0.3 | Ablate each to 0 (Stage 2) before trusting any |
| Score | entry / strong / fade thresholds | 30 / 55 / 10 | entry 25–45; strong ≥ entry+15; fade 0–20 |
| Quality | ATR percentile min/max | 20 / 95 | 15–35 / 90–99 |
| Quality | BBW percentile floor | 10 | 5–25 |
| Quality | assumed cost (ticks/side) | 1 | **Set to your real spread+slippage.** 0 disables cost gates (not recommended) |
| Quality | Min ATR÷cost, Min stop÷cost | 3 / 5 | The core microstructure defense |
| Quality | Cooldown bars | 5 | 3–15 |
| Quality | Candle + momentum-turn confirms | on / on | Ablate individually |
| Quality | Block TRANSITION signals | on | Ablate |
| Session | enable / window / tz | off / 0700-1900 / Exchange | Enable for RTH markets; validate per session |
| Risk (strategy) | stop ATR×, R:R | 1.5 / 1.5 | stop 1.25–2.5; R:R 1.0–2.0 (≥1.2 reduces intrabar ambiguity) |
| Risk | break-even after R / offset | 1.0 / 1 tick | 0.75–1.5R |
| Risk | trail ATR× after R | 2.0 / 1.0 | Trail wider than initial stop |
| Risk | time stop | off / 60 bars | Test 30–120 bars on 1m |
| Risk | score-fade exit | on | Momentum-deterioration early exit |
| Size | mode / risk % / max leverage | Risk% / 0.5% / 1.0 | 0.25–1.0% risk; keep maxLev=1 unless validated |
| Backtest | date range | — | Set in TV's Strategy Tester / `barstate`-safe; protocol Part 10 |

**Degrees-of-freedom warning:** this is ~30 parameters. That is *more* than a minimal system needs, which is exactly why Part 10 Stage 2 (ablation) and Stage 9 (perturbation) are mandatory before any parameter is trusted.

---

# PART 8 — TRADING STRATEGY (1-MINUTE OPERATION MANUAL)

### BEFORE TRADING
1. **Instrument**: only liquid, low-spread symbols (top crypto pairs on major venues, FX majors in session, index futures/CFDs in RTH). Check the info table's **Cost gate** — it must read OK with your true spread entered.
2. **Session**: enable the session filter for non-24h markets; for 24h markets, verify from your Part 10 Stage 7 results which sessions carry the edge, then restrict to those.
3. **HTF context**: the 15m bias is on by default; confirm the table's HTF row agrees with your own read of the 15m chart.
4. **Volatility check**: table's Volatility row. Do not trade SQUEEZE breakouts against the gate (bbwPct floor) or in HIGH VOL (> your max percentile) — the system blocks these automatically, but understand why.

### ENTRY
- **BUY**: at bar close — score crosses above +30 while regime is TREND-UP or RANGE (not TRANSITION), 15m bias not bearish, confirmation candle closed up in the upper half of its range, momentum turning up, volatility band OK, cost gate OK, cooldown elapsed. Enter at next bar open (strategy does this automatically; discretionary traders: place market order within seconds of the close).
- **SELL**: exact mirror at −30.

### STOP
- Initial stop = signal-bar close ∓ **1.5 × ATR(14)** (ATR at signal time). Never widen it. If spread+slippage > ⅕ of the stop distance, the trade should have been rejected by the cost gate — re-check your spread input.

### TAKE PROFIT
- Bracket target at **1.5R** (default). The ATR trail (2×ATR after +1R) may capture more in strong trends; the strategy exits at whichever hits first.

### MANAGEMENT
- **Break-even**: stop → entry+1 tick once price travels 1R favorably.
- **Trailing**: 2×ATR from close, ratcheting, active after 1R.
- **Invalidation**: score-fade exit (score crosses back through ±10) closes early on momentum deterioration; opposite full signal reverses; optional time stop (60 bars default when enabled); session-end flatten when the session filter is on.
- You may manually override on scheduled news: the system has **no news filter** — that is your job.

### WHEN NOT TO TRADE
- Table shows TRANSITION regime, SQUEEZE just releasing, ATR percentile at the gates' edges, cost gate FAIL, session filter CLOSED, major scheduled releases within minutes, spread widened (news/rollover/illiquidity), data gaps on the chart, or when your validation for *this symbol/session* (Part 10) hasn't passed. Discretionary "one more trade" against failed validation is how accounts die.

---

# PART 9 — ALERT SETUP (exact steps)

**Indicator (Version A):**
1. Add *Ultimate 1M System — Oscillator* to a 1m chart. Configure inputs.
2. Click ⏰ **Alert** → Condition: the indicator name.
3. Choose one of: `U1M BUY`, `U1M SELL`, `U1M BUY STRONG`, `U1M SELL STRONG`, `U1M EXIT LONG (fade)`, `U1M EXIT SHORT (fade)`, `U1M REGIME CHANGE`.
4. **Trigger: "Once Per Bar Close"** — mandatory. Any other trigger reintroduces realtime uncertainty the system is designed to avoid. Expiration: open-ended as desired.
5. Notification options per your plan. Save.
6. *Alternative — structured payload*: Condition → **Any alert() function call**. You then receive the JSON line (`sym, tf, sig, score, conf, regime, vol, px, atr, stop, target, t`) on every confirmed signal/exit-fade event; it is generated only via `alert()` gated by `barstate.isconfirmed` with `freq_once_per_bar_close`, so it cannot fire mid-bar. Webhook consumers should parse this JSON.

**Strategy (Version B):**
1. Add the strategy to the chart. In the alert dialog choose Condition: strategy name → **"Order fills and alert() calls"** (or "alert() function calls only").
2. Order-fill alerts use the `alert_message` texts ("U1M LONG entry" etc.). To include dynamic data in order-fill messages, use TradingView's placeholders (e.g. `{{strategy.order.action}}`, `{{strategy.order.contracts}}`, `{{close}}`) in the alert dialog's message box — placeholders are resolved by TradingView at fill time, not by the script.
3. Same frequency discipline as above; strategy order events are inherently confirmed-bar driven here because `calc_on_every_tick=false`.

**Verification before going live:** forward-test on paper for ≥ 2 weeks and confirm every alert timestamp matches the bar close (not mid-bar), and that no alert ever appears, disappears, or moves after the bar closes.

---

# PART 10 — BACKTESTING PROTOCOL (the heart of this project)

Run in this order. **Any failure at a gate means stop, simplify, or reject — never "tune until it passes."**

**Stage 0 — Fidelity setup.** Deep backtesting / maximum 1m history for the symbol; commission ≥ realistic; slippage ≥ 1 tick; `process_orders_on_close=false`. Record TV's data limitations for the symbol (1m history depth, gaps).

**Stage 1 — Baseline.** Score-only: all quality filters OFF (atr/bbw/cost/session/cooldown/confirms/HTF/transition-block). This is the naive model. Expect it to look mediocre — that is the honest reference.

**Stage 2 — Hypothesis testing (ablation).** Turn ON one component/filter at a time; accept a filter only if it improves **out-of-sample** PF or Sharpe by a clear margin (e.g., ≥ 10% relative) and not via one lucky cluster of trades. Also ablate *components*: set `wSar=0`, `wMom=0`, etc. Components that never help: remove (the SAR weight is the prime candidate).

**Stage 3 — Parameter sensitivity.** For each core parameter (entryScore, stopMult, rrRatio, trendMixTh, EMA lengths), scan ±30–50% in ~7 steps. You are looking for **plateaus, not peaks**. If performance collapses away from one point value, that parameter is curve-fit: widen it, simplify, or drop the feature.

**Stage 4 — In-sample optimization.** On the training window only (e.g., oldest 60% of 1m data), tune at most 3–4 parameters, keeping neighbors viable per Stage 3.

**Stage 5 — Out-of-sample validation.** Freeze everything; run the middle 20% unseen data. Gate: PF ≥ 1.15 and positive expectancy **after pessimistic costs**, ≥ 200 trades ideally.

**Stage 6 — Walk-forward.** Rolling windows (e.g., train 3 months → test 1 month, roll monthly, ≥ 12 folds). Aggregate only the test folds (this is the walk-forward equity curve). Gate: aggregated WF result positive after costs; profitable in ≥ 60% of folds; no single fold > ~40% of total profit.

**Stage 7 — Regime & session validation.** Bucket trades by regime (trend up/down, range), vol state, session (run variants with different `sessStr` windows or export the trade list and bucket offline). No single bucket may carry > ~50% of net profit; if it does, the "edge" is one market state and should be *restricted to it*, honestly.

**Stage 8 — Stress testing.** Recompute with: 2× commission; +1 tick slippage; entry threshold +5; stop 1.25×. The edge may shrink; it must not invert. (True execution-delay simulation is not directly expressible in Pine — the conservative proxy is extra slippage ≈ 0.1–0.25 × ATR in ticks; label it as a proxy.)

**Stage 9 — Perturbation & PBO.** Monte Carlo: jitter each parameter ±10% uniformly, 100+ draws; the 10th-percentile result must remain non-negative. Export the trade list and estimate PBO via CSCV (Bailey et al. 2015) offline (Python/R) across your Stage-2/3 runs: PBO > 0.5 ⇒ reject; ≤ 0.2 ⇒ acceptable; between ⇒ shrink the model. Also randomize trade order / bootstrap returns for a drawdown distribution.

**Stage 10 — Final untouched test.** Reserve the most recent 20% of data from the very beginning. Run once. Report, don't iterate. If it fails — the conclusion is **"no sufficiently robust edge was demonstrated"** for this symbol/period. That is a legitimate, expected outcome for 1-minute systems.

**Multi-symbol matrix (Part 24 of the brief):** repeat Stages 5–10 on BTC, ETH, one FX major, gold, one equity index (where data allows). An edge present in 1 of 5 symbols with no structural reason is data mining, not alpha.

---

# PART 11 — PERFORMANCE EVALUATION FRAMEWORK

Report **all** of (TradingView Strategy Tester provides most; export the trade list for the rest):

| Metric | Definition / note | Suggested gate (post-cost) |
|---|---|---|
| Net / gross profit, gross loss | Gross vs net gap reveals cost drag | Net ≥ 0; gap < 50% of gross ideally |
| Profit factor | grossProfit / grossLoss | ≥ 1.15 OOS, ≥ 1.3 IS |
| Expectancy per trade | mean(PnL), also in **R units** (PnL / initial risk) | > 0 with bootstrap 95% CI excluding 0 |
| Win rate, avg win/loss | With R:R 1.5, breakeven WR ≈ 40% | Meaningless alone — always with R |
| Average / median trade duration; trades per day & hour | Detect accidental noise-scalping (duration ≈ 1–3 bars and hundreds of trades ⇒ suspicious) | — |
| Max drawdown (abs & %), recovery factor | From equity curve + Monte Carlo drawdown distribution | MaxDD ≤ ~15–20% at default risk |
| Sharpe / Sortino (TV annualizes by chart TF — compare only like-for-like) | Risk-adjusted core | Report both IS and OOS |
| Consecutive wins/losses, largest winner/loser | Streak risk sizing | Largest winner < ~10% of net profit (else one trade carries the test) |
| Long vs short, session, regime splits | TV reports long/short natively; sessions/regimes via filtered reruns or offline bucketing | No split > ~50% of profit |
| Cost stress rows | Realistic vs 2× costs | PF ≥ 1.0 under stress |
| Walk-forward & OOS rows | The only rows that matter for the go/no-go | Per Part 10 gates |

**Primary comparison, always:** gross performance vs net performance after pessimistic costs. If the story changes between them, the honest story is the net one.

---

# PART 12 — FAILURE MODES

1. **Chop regimes worse than modeled** — trendMix lags regime shifts; expect whipsaw clusters right after strong trends end. Mitigation already built: transition buffer, cooldown, fade exits. Residual risk: real.
2. **Cost regime shifts** — spread widening (news, rollover, exchange issues) silently turns R ≥ 1.2 trades into negative-expectancy trades. The static `spreadTicks` input cannot see this live.
3. **Volatility shocks** — news spikes blow through ATR stops with slippage far beyond 2 ticks; the emulator will understate this. The max-ATR gate reduces exposure but cannot eliminate gap risk.
4. **HTF filter lag** — at V-reversals the confirmed 15m veto keeps you in old-direction trades briefly; it also saves you in sustained reversals. Net effect must be validated (ablate `useHTF`).
5. **Parameter decay** — any published edge decays as conditions/crowding change; re-run Stage 6 quarterly.
6. **Emulator optimism/pessimism** — single-bar stop+target ambiguity; bar-magnifier off by default.
7. **Symbol-specific traps** — tick/lot rounding on some FX/CFD feeds making `qty` invalid (entries silently skipped — watch `qtyOk`), weekend gaps on crypto CFDs, thin session liquidity on equities pre-market.
8. **Data quality** — 1m gaps/outages; results on patched history overstate reliability.
9. **Overfitting** — the default end-state of undisciplined tuning. PBO protocol exists for this reason.
10. **Psychology** — bar-close signals mean acting within seconds, repeatedly, at size. Paper-trade first; the strategy's alert cadence must be operationally sustainable.

---

# PART 13 — FINAL RECOMMENDED CONFIGURATIONS

**None of these are optimized or guaranteed.** They are internally consistent starting points ranked by conservatism. Validate each through Part 10 before use.

| Parameter | CONSERVATIVE | BALANCED (as shipped) | AGGRESSIVE |
|---|---|---|---|
| entryScore / strongScore | 40 / 60 | 30 / 55 | 25 / 50 |
| Cooldown bars | 10 | 5 | 3 |
| ATR percentile min/max | 30 / 90 | 20 / 95 | 10 / 98 |
| BBW floor | 20 | 10 | 5 |
| Both confirmations | on | on | on (candle) |
| HTF filter | on (15m) | on (15m) | on (5m) or off* |
| Block TRANSITION | on | on | on |
| Stop (ATR×) / R:R | 2.0 / 1.2 | 1.5 / 1.5 | 1.25 / 2.0 |
| BE after R / trail ATR× after R | 1.0 / 2.5 after 1R | 1.0 / 2.0 after 1R | 0.75 / 1.75 after 0.75R |
| Time stop | 120 bars | off (or 60) | off |
| Risk % / max leverage | 0.25% / 1.0 | 0.5% / 1.0 | 1.0% / 2.0 |
| Costs in backtest | pessimistic (2× realistic) | realistic | realistic |

\* HTF-off is only acceptable if Stage 2 ablation showed the filter adds nothing on your market.

---

# PART 14 — FINAL AUDIT

Legend: **[x]** done and verified here · **[~]** done here to the extent possible in this environment · **[ ]** must be completed by you (tool/method required that this environment cannot provide).

- [x] **Pine v6** — `//@version=6`, v6-only semantics respected (strict bools: no `na()`/`nz()` on bools; no implicit int→bool; lazy `and`/`or`; no `when=` params; `dynamic_requests` left at default with a single, static, global-scope request).
- [~] **Compiles** — hand-audited against v6 docs + custom static linter (`tools/pine_sanity_check.py`: namespaces, bracket balance, tab check, repaint-primitive scan, `alertcondition` const-message check) passes clean. **A Pine compiler does not exist in this sandbox; paste both files into the Pine Editor as the authoritative compile check. Expect zero errors; if the editor flags anything, it will be cosmetic, not structural.**
- [x] **No lookahead** — no future indexing (`[negative]`), no pivots, no `ta.valuewhen` misuse, no unconfirmed HTF values.
- [x] **No future leakage** — single `request.security()` uses the documented non-repainting pattern `ta.ema(close, len)[1]` + `lookahead_on`, guarded by `timeframe.in_seconds()` validation (cited in Part 2).
- [x] **Repainting behavior documented** — header of both files; open-bar values may fluctuate until close (benign, disclosed); signals final at close; alerts bar-close-only; nothing moves after the bar closes.
- [x] **Confirmed signals** — triggers are close-cross events; `alert()` gated by `barstate.isconfirmed`; strategy `calc_on_every_tick=false`.
- [x] **Realistic execution assumptions** — next-open fills, `process_orders_on_close=false`, slippage ticks, declaration-level commission, margin set, bar-magnifier caveat disclosed, spread proxy gates.
- [x] **Commissions included** · [x] **Slippage included** — with explicit stress-test multipliers in the protocol.
- [x] **Risk management included** — ATR bracket at signal time, break-even, ratcheting trail, time stop, session flat, risk-% sizing with leverage cap and zero/na guards.
- [ ] **Out-of-sample testing** — protocol Stage 5 (TradingView + your execution; cannot be run from here).
- [ ] **Walk-forward testing** — protocol Stage 6.
- [ ] **Parameter sensitivity** — protocol Stage 3 (method specified; charts to be produced by you).
- [~] **Overfitting controls** — architecture enforces low redundancy, plateau rule, perturbation gate, PBO/CSCV method cited and prescribed; the actual PBO number requires your run.
- [ ] **Regime testing** — protocol Stage 7.
- [ ] **Long/short testing** — strategy reports long/short natively; verify symmetry rather than assuming it.
- [ ] **Alert testing** — procedure in Part 9 (requires a live TradingView session; 2-week paper-forward-test specified).
- [x] **Computational-efficiency review** — O(1) per bar, zero loops, one table updated on last bar only, single security call, `max_bars_back` bounded; no object churn.
- [~] **Adversarial review** — attempted breaks and fixes: bracket moved to signal time (protection gap), side-change reset (reversal state bug), bool-na elimination (v6), security guard (LTF misuse), cost gates (untradeable stops). Remaining known weaknesses are disclosed (Part 12), not hidden.
- [~] **Limitations disclosed** — Parts 1, 2.4, 12; plus the global honesty note: **no performance claims are made anywhere in this deliverable, and none should be inferred.**

---

*Final word (Part 37 of the brief, operationalized):* the objective here was never "settings that made the past look amazing" — it is a falsifiable framework whose defaults are defensible, whose signals cannot lie to you about when they became known, and whose validation protocol is capable of returning the answer **"no sufficiently robust edge was demonstrated."** If that is the answer after Part 10, believe it.
