# QMa11 Science Brief — 8 July 2026

**Source:** Constantin Liviu NITA / Merlin — daily QMa11 Science Brief.
**Purpose:** Reference for RONOR Build Week submission narrative + citations.

## Executive signal

QMa11 as a **layered grid-intelligence stack**:

`probabilistic forecasting → stochastic flexibility valuation → hybrid quantum/classical combinatorial selection → classical feasibility recovery → inverter-aware control → physics/safety certification → verified-gain OSaaS`

## Key signals

### 1. New today — multi-agent DRL for site-level battery management (dairy farms)
- 7 Jul 2026 paper: two-layer controller (upper = dynamic pricing, lower = multi-agent RL)
- **+18% arbitrage profit** vs rule-based; better DG use; Irish grid-code voltage compliance
- QMa11: treat each C&I / agri site as local multi-agent env → aggregate into VPP portfolio
- BESS optimisation must simultaneously preserve voltage compliance + use local generation + keep site eligible for grid-service participation

### 2. Foundation-model forecasting judged by grid outcomes, not MAPE
- Chronos-Bolt/Chronos-2/TabPFN-TS across 200 LV feeders
- QMa11 metric: **Grid-Useful Forecast Accuracy** = avoided operational cost + avoided grid-risk

### 3. Electricity-price forecasting → TSFMs + domain models as ensembles
- 2 Jul 2026 ICML workshop: TSFMs competitive but not consistently better than domain-specific EPF
- QMa11 design: `TSFM temporal representation + market fundamentals + graph/coupling features + quantile/tail-risk + optimiser`
- **Target = spike/tail accuracy, not average accuracy** (BESS/VPP/ancillary profits concentrated in stress intervals)

### 4. Reliability thresholds as decision variables
- Nordic FCR-D: **14.5% procurement cost reduction** with optimised threshold
- **+2.4% with dynamic hourly thresholds**
- Reserve bid model: `MW × P(delivery) × SoC risk × P(activation) × penalty exposure × degradation cost`

### 5. Safe AI control: "AI proposes, physics disposes"
- Ronor supervises interpretation/alerting/operator interaction
- QMa11 execution layer must remain physics-gated

### 6. BESS = inverter-defined asset
- Registry must include: GFM/GFL/hybrid mode, droop settings, reactive-power capability, weak-grid capability, FRT constraints, black-start/islanding capability, HIL validation status, grid-code mode

### 7. Time-to-boundary safety margin
- QMa11 objective: `max verified gain above baseline s.t. SoC + degradation + market + network + inverter + grid-code + dynamic-stability`

### 8. Quantum = graph pruning + combinatorial compression
- QMa11 Flexibility Graph: nodes = assets/bids/flexibility blocks; edges = incompatibility/correlation/congestion/co-activation risk

### 9. Qubit-efficient POPF (5 qubits vs 600+ for 69-bus)
- Uncertainty compression → region classification → candidate selection → classical feasibility recovery → grid-safety certification

### 10. Multi-market BESS value-stacking (+7.56% profit)
- QMa11 module: `DAM/ID arbitrage + FCR/aFRR reserve + imbalance trading + SoC compliance + degradation budget + penalty-risk control`

### 11. Grid fees dominate BESS profitability
- QMa11 must treat tariffs / grid fees / exemptions / green-cert treatment / network charges as **first-class variables**
- Romania: double-charging reforms, balancing rules, route-to-market contracts change investment case more than optimiser itself

### 12. Romania/EU policy window aligned with QMa11
- Horizon Europe 2026-2027: **€100M smart-grid + €75M AI energy + €190M digital = €365M**
- DNV: RO 2025 DAM avg €110/MWh, max daily spread €168/MWh, aFRR ~€9/MW/h, FCR ~€70/MW/h, BESS revenue ~€120-180/kW/year
- €150M RO state-aid scheme, min 2,174 MWh storage
- First pilot: `baseline policy → QMa11 optimised policy → audited incremental gain → OSaaS fee only on verified gain`
