# OpenAI Build Week — RONOR Hackathon Guide

This guide covers everything you need to do to successfully submit the **RONOR Model Exchange v0.1** prototype for the OpenAI Build Week hackathon (Deadline: July 21, 2026).

The package includes the working prototype, automated checks, deployment configuration, and submission materials. Run `npm run check` after extraction and before deployment.

---

## Step 1: Generate the Codex Session ID

The hackathon requires proof that you used OpenAI Codex (ChatGPT) to build the feature.

1. Open ChatGPT (ensure you are using the latest model).
2. Open the file `codex/CODEX_INSTRUCTIONS.txt` included in this zip.
3. Copy the text between the dashed lines and paste it into ChatGPT.
4. Ask Codex to inspect the repository, run `npm run check`, and make only evidence-based improvements. Review and retain the resulting changes before submission.
5. **Save the URL of the ChatGPT conversation.** This is your "Codex Session ID" required for Devpost.

---

## Step 2: Set up the GitHub Repository

1. Go to [GitHub](https://github.com/) and create a new repository called `ronor-runtime`.
2. Extract the contents of the provided zip file into a local folder.
3. Open your terminal in the folder and run:
   ```bash
   git init
   git add .
   git commit -m "Initial commit: RONOR Model Exchange v0.1"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/ronor-runtime.git
   git push -u origin main
   ```

---

## Step 3: Deploy (Cloudflare Pages or Render/Railway)

Because this is a Node.js Express app (not just static files), the easiest free deployment is **Render** or **Railway** (Cloudflare Pages requires rewriting the Express app to Workers syntax, which we avoided to keep the routing logic pure and portable).

**Deploying on Render.com:**
1. Create a Render account and click **New Web Service**.
2. Connect your GitHub repo `ronor-runtime`.
3. Build Command: `npm install && npm run build`
4. Start Command: `npm start`
5. **Environment Variables:** Add `OPENAI_API_KEY` with your `sk-...` key.
6. Click Deploy. Save the live URL.

---

## Step 4: Record the Demo Video

You need a short (under 2 minutes) screen recording demonstrating the prototype.

### Video Script:

> **[0:00 - Screen shows the RONOR Dashboard]**
> "Hi, for OpenAI Build Week, we built RONOR — a Sovereign Generative Intelligence Runtime. National governments and enterprises face massive strategic risk by locking into single-provider AI. RONOR solves this by abstracting the intelligence supply chain."

> **[0:15 - Point to the 7 Planes diagram on the bottom right]**
> "Every request passes through seven operational planes: Access, Policy, Routing, Execution, Assurance, Economics, and Evidence."

> **[0:25 - Click the 'Reasoning -> GPT-4.1' sample button]**
> "Let's submit a strategic reasoning query. The Policy Engine evaluates constraints, and the Dynamic Router scores all eligible models. Here, you can see the transparent scoring table. OpenAI GPT-4.1 won based on Quality and Evidence reliability, despite a cost penalty."

> **[0:45 - Scroll to Answer and Assurance panels]**
> "The Execution plane ran the real OpenAI API. The Assurance plane verified the output, giving it an 88% confidence score and extracting the source attribution."

> **[0:55 - Click the 'Calculation -> Deterministic Core' sample button]**
> "If we submit a math calculation, the Policy Engine's deterministic-first rule kicks in. The router bypasses generative models entirely and routes to our local Deterministic Core. Zero cost, zero latency, 100% verifiable."

> **[1:15 - Scroll to Cost and Trace Ledgers]**
> "Everything is tracked. The Cost Ledger updates per-token economics in real time. And the Trace Ledger creates an immutable, hash-chained audit record of exactly *why* a model was chosen and what it cost."

> **[1:30 - Wrap up]**
> "RONOR makes AI provider-neutral, model-portable, and evidence-governed. Thank you."

Upload the video to YouTube (Unlisted) or Vimeo, and save the link.

---

## Step 5: Submit on Devpost

Go to the OpenAI Build Week Devpost page and fill out the form:

- **Project Name:** RONOR Model Exchange
- **Category:** Developer Tools
- **Elevator Pitch:** A Sovereign Generative Intelligence Runtime — provider-neutral, model-portable, and evidence-governed AI orchestration.
- **Project Story:**
  - *Inspiration:* National governments and critical enterprises face unacceptable strategic risks (vendor lock-in, data sovereignty, opaque supply chains) when relying on single-provider AI. We needed an orchestration layer to govern intelligence.
  - *What it does:* RONOR provides a Unified Request API that routes queries across multiple engines (OpenAI, Anthropic, local deterministic cores). A Dynamic Router scores models based on Quality, Cost, Latency, Operational Risk, Sovereignty, and Evidence Reliability. It includes real-time Cost and Trace Ledgers for full auditability.
  - *How we built it:* We built a Node.js/Express runtime and a React dashboard. The Execution plane integrates directly with the OpenAI API (JSON mode) for high-end reasoning tasks. We used Codex to engineer the transparent scoring algorithms and the React data visualization components.
- **Try it out links:** [Paste your Render/Railway live URL]
- **Video Demo Link:** [Paste your YouTube/Vimeo link]
- **GitHub Repo:** [Paste your GitHub link]
- **Codex Session ID:** [Paste the ChatGPT URL from Step 1]

Submit before July 21!
