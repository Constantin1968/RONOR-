# QMa11 Science Brief — 7 July 2026

**Source:** Constantin Liviu NITA / Merlin — daily QMa11 Science Brief, Europe/Bucharest.
**Purpose:** Reference for RONOR Build Week submission narrative + citations.

## Executive signal

QMa11 should not be built as "quantum solves the grid." The credible architecture is:

**energy/time-series foundation models → probabilistic scenarios → hybrid quantum/classical combinatorial selection → classical feasibility recovery → inverter-aware and stability-certified control → verified-gain OSaaS.**

**RONOR's role:** the governance and audit layer that makes every step of this pipeline auditable, policy-checked, and bankable.

## Key signals

### 1. Low-voltage forecasting — application-metric driven
- **200 LV feeders**, Chronos-2 strong but application-metric matters more than MAPE
- QMa11 forecast quality → avoided overload, peak shaving, transformer breach avoidance, reserve headroom, BESS SoC readiness, imbalance exposure

### 2. Ancillary-service reliability as optimisation variable
- **Nordic FCR-D: 14.5% procurement cost reduction** with optimised reliability threshold
- **+2.4% savings** with dynamic hourly thresholds
- QMa11 reserve bid model: `available MW × probability of delivery × activation risk × SoC/degradation cost × market penalty exposure`

### 3. Safe AI grid control = generative policy + symbolic safety stack
- **NPCC 140-bus: >99% ACE integral reduction, 59.4 Hz nadir, ~10 ms inference**
- Architecture: `offline-trained policy → symbolic constraint verification → dynamic digital twin → fallback to classical AGC/MPC/OPF`
- **"AI proposes; physics disposes."** Perfect description of the RONOR MI9 Gate philosophy.

### 4. BESS = inverter-aware, not just MW/MWh
- GFM/GFL/hybrid mode, reactive-power range, droop settings, weak-grid capability, virtual impedance, FRT limits, black-start potential

### 5. Time-to-boundary margin as safety metric
- **New England 39-bus: CCT within 1.8–6.0%**
- QMa11 objective: `maximise verified gain above baseline subject to SoC, degradation, market, grid-code, network, and dynamic-stability constraints`

### 6. Quantum dispatch — compression, not replacement
- **qRBM UC: 223× qubit reduction, 99.96% computation-time reduction**
- Credible QMa11 quantum pipeline: `forecast scenarios → reduce candidate space → quantum/hybrid ranking → classical MILP/MIQP/OPF recovery → digital-twin validation`

### 7. Quantum-informed graph pruning (Quantinuum, 225 assets, 78 qubits)
- Transferable to VPP portfolio selection
- QMa11 Flexibility Graph: nodes = asset/bid/flexibility blocks; edges = incompatibility/correlation/congestion/shared constraints

### 8. Hybrid AI for price forecasting
- **FutureBoosting: >30% MAE reduction** (frozen TSFM + downstream regression)
- **European EPF: 12–13% RMSE, 15–18% MAE reduction** with hybrid linear/nonlinear + online learning

### 9. VPP scheduling via spectral (PCE) uncertainty
- **137× reduction in computational effort** vs. scenario-based benchmark
- Directly relevant to QMa11 tractability

### 10. EU policy validates sovereign AI energy positioning
- EC digitalisation & AI roadmap for energy, **3 June 2026** — explicit sovereign AI direction
- Horizon Europe topic: generative-AI-powered "digital spine" of EU energy system
- Right public-facing phrase: *"sovereign, grid-safe AI and quantum-assisted optimisation for flexibility discovery, BESS/VPP dispatch, forecasting, and verified-gain energy services"*

### 11. Romania — proving ground, but bankability is the constraint
- **ANRE 2025:** double-taxation of stored electricity eliminated (stored + reinjected exempted from regulated tariffs)
- **May 2026 Romanian BESS market analysis:** favourable regulation + grid-allocation reform + EU funding + volatility, but *bankability is the central challenge*
- Commercial proof structure:
  `baseline policy → QMa11 optimised policy → audited incremental gain → OSaaS fee on verified gain above baseline`

## Doctrine

> QMa11 is a hybrid quantum-AI optimisation layer for energy systems where foundation models generate calibrated forecasts, stochastic methods compress uncertainty, quantum/hybrid solvers assist hard combinatorial selections, and physics-certified digital twins validate BESS, VPP, dispatch, and ancillary-service actions before execution.

> QMa11's edge is not quantum alone. Its edge is the disciplined coupling of AI forecasting, probabilistic flexibility, quantum-assisted combinatorial optimisation, inverter-aware control, and verified-gain OSaaS.

## RONOR positioning derived from this Brief

**RONOR is the governance-and-audit spine that turns the QMa11 pipeline bankable:**

1. Every forecast used = evidence gate (source count, freshness, consensus)
2. Every reserve bid = MI9 Gate risk-tier + confidence + policy check
3. Every AI-proposed action = safety envelope (physics disposes)
4. Every dispatch = SHA-256 audit receipt tied to baseline comparison
5. Every OSaaS invoice = cryptographic proof of verified gain

Without RONOR, the QMa11 architecture is a research pipeline. With RONOR, it is a bankable operational system.
