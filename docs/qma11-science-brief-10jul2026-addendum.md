# QMa11 Science Brief — Addendum, 10 July 2026

**Source:** Constantin Liviu NITA / Merlin.
**Purpose:** Reference for RONOR Build Week submission narrative + citations.

## Executive signal

Four late-day results. The most important: **phase-jump response requirements can imply a hardware overcurrent capability that software cannot compensate for**. On the quantum side, an interesting dense-graph decomposition method appears, but still without proof of advantage vs strong classical optimisers.

## Signals

### 1. Grid-forming BESS: physical boundary between controller and hardware (priority: very high)
- Phase-jump grid-code tests implicitly encode a minimum current overload requirement
- Convex optimal-control formulation → strict current limit → **frontier independent of controller architecture**
- If inverter lacks instantaneous overcurrent capability, no software optimisation can produce the requested power trajectory
- Validated EMT on three WECC generic GFM inverter models
- **QMa11 registry must add:** continuous + transient max current, admissible overcurrent duration, thermal recovery curve, certified phase-jump response, current-limiting strategy, hardware-limited operating point, EMT/HIL results with test conditions
- Distinguish: `controller deficiency → parameter deficiency → inverter hardware deficiency`
- Romania: compliance matrix between manufacturer specs + Transelectrica/DSO requirements + real verified capability. Generic "grid-forming ready" is insufficient.

### 2. Reachability-Preserving Bellman Operator — Safe RL certification
- Exact bridge between Hamilton-Jacobi reachability and RL
- Non-additive Bellman operator whose fixed point preserves reachability semantics (not just cumulative-reward approximation)
- Standard RL optimises cumulative reward but may temporarily traverse unsafe states
- Reachability: "can the system avoid unsafe set on the ENTIRE trajectory?"
- **QMa11 unsafe set:** SoC/temp out of bounds, non-conformant V/f, inverter overcurrent, stability loss, reserve non-delivery, dynamic operating envelope breach
- **Recommended architecture:** `RL policy → reachability-value check → physics/digital-twin validation → fallback controller`

### 3. Quantum: FrozenLGP — robust decomposition for dense Flexibility Graphs
- 9 Jul 2026: Adaptive Qubit Freezing for Divide-and-Conquer QAOA
- Minimum-vertex-cut identifies obstructive nodes → freeze classically → transfer edge contributions to Ising bias
- **Tested up to 10,000 nodes; decomposition possible for 100% of instances (vs 4.6% for standard D&C on very connected graphs)**
- Smaller circuits, better noise robustness in simulations
- **QMa11 Flexibility Graph frozen nodes:** obligatorily-committed assets, critical feeder constraints, evidently-incompatible flexibility blocks, contract/grid-code-fixed decisions, near-boundary inclusion/exclusion assets
- **Discipline:** paper shows decomposition coverage, NOT economic/computational quantum advantage. QMa11 must benchmark FrozenLGP-QAOA vs MILP + CP-SAT + Gurobi/SCIP + spectral + classical graph partitioning.

### 4. Confidence tubes between measurements — Uniform High-Probability ISS Tubes
- Probabilistic intervals valid across entire trajectory between two sampling events
- Separates: process disturbance + measurement noise + inter-sample error
- **QMa11 Layer 0:** SCADA/BMS reading NOT treated as exact state until next message
- Maintains **state-confidence tube** that widens with latency, packet loss, asset dynamics
- **Operational consequence:** bidable flexibility must reduce when state uncertainty grows, even if last telemetry looked favourable
- Applicable to BESS with heterogeneous telemetry + VPP portfolios with varying measurement frequencies

## Three QMa11 extensions justified by this addendum

1. **Hardware Capability Boundary** — separates controller limits from physical inverter limits
2. **Reachability Safety Certificate** — verifies entire proposed trajectory, not just final state
3. **Telemetry Confidence Tube** — turns latency + measurement uncertainty into explicit reduction of bidable flexibility

## Updated QMa11 chain

`state estimate + confidence tube → robust operating envelope → market optimisation → quantum/classical candidate selection → reachability certificate → inverter/hardware feasibility → EMT/HIL gate → execution`

## Key doctrine update

**There is no new credible quantum-advantage proof today for energy dispatch. The most valuable quantum contribution is a better problem-preparation and decomposition method, NOT replacement of the classical optimiser.**

## RONOR narrative implication

The 10 Jul addendum sharpens the RONOR Exposure Analysis dimensions:

- **Operational exposure** must now include a "hardware-limited operating point" flag from the inverter registry (Signal 1)
- **Model exposure** must incorporate reachability certification, not only confidence (Signal 2)
- **Cyber exposure** already covered by hash-chain, but a new "telemetry confidence" driver aligns with Signal 4
- Quantum roadmap in the README must state explicitly: RONOR governs the classical + hybrid + quantum layers uniformly; audit chain does not care which layer proposed the action (Signal 3)
