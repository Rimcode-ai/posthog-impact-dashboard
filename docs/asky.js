/* Ask AI — multi-agent grounded Q&A over the live PostHog impact dataset.
 *
 * Pipeline (all client-side, all live):
 *   1. Pre-guard   (deterministic) — scope + prompt-injection strip
 *   2. Researcher  (LLM)           — extracts the relevant data slice + plan
 *   3. Analyst     (LLM)           — composes the answer using ONLY that slice
 *
 * Hallucination containment is structural, not a post-hoc regex:
 *   - The Researcher is constrained by system prompt to only choose logins that
 *     appear in the dataset, and emits strict JSON.
 *   - The Analyst only ever sees the Researcher's filtered slice, never the
 *     full dataset, and is told NEVER to invent handles.
 *   This is more reliable than regex-matching free-form English for handles.
 *
 * Providers: Anthropic Claude · OpenAI · Google Gemini. User picks one in the modal.
 * Optional: LangSmith REST tracing if the user provides a key (provider-agnostic).
 *
 * Hard rules:
 *   • No baked / canned answers — every response is a live LLM run on data.json.
 *   • Keys stay in localStorage and are sent only to the selected provider's API.
 *   • If validation fails, the answer is BLOCKED and we tell the user why,
 *     and we suggest a precise rephrased question — built from real handles
 *     and dataset fields — that we know can be answered from the live data.
 */

(function () {
  const LANGSMITH_URL = "https://api.smith.langchain.com/runs";

  const PROVIDERS = {
    anthropic: {
      label: "Anthropic Claude",
      keyPrefix: "sk-ant-",
      keyLabel: "Anthropic API key",
      defaultModel: "claude-haiku-4-5-20251001",
      keyStorage: "askai.anthropic_key",
      modelStorage: "askai.anthropic_model",
    },
    openai: {
      label: "OpenAI",
      keyPrefix: "sk-",
      keyLabel: "OpenAI API key",
      defaultModel: "gpt-4o-mini",
      keyStorage: "askai.openai_key",
      modelStorage: "askai.openai_model",
    },
    gemini: {
      label: "Google Gemini",
      keyPrefix: "AIza",
      keyLabel: "Google Gemini API key",
      defaultModel: "gemini-2.0-flash",
      keyStorage: "askai.gemini_key",
      modelStorage: "askai.gemini_model",
    },
  };

  const KS = {
    provider:  "askai.provider",
    langsmith: "askai.langsmith_key",
    project:   "askai.langsmith_project",
  };

  const state = {
    initialized: false,
    busy: false,
  };

  function getKey(k) { return localStorage.getItem(k) || ""; }
  function setKey(k, v) { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); }
  function activeProvider() {
    const p = getKey(KS.provider);
    return PROVIDERS[p] ? p : "anthropic";
  }
  function activeModel() {
    const p = activeProvider();
    return getKey(PROVIDERS[p].modelStorage) || PROVIDERS[p].defaultModel;
  }
  function activeProviderKey() {
    return getKey(PROVIDERS[activeProvider()].keyStorage);
  }

  // ---------- guards ----------

  const INJECTION_PATTERNS = [
    /ignore (?:all |the )?(?:previous|prior|above)/i,
    /disregard (?:the )?(?:system|above|previous)/i,
    /you are (?:now )?(?:a |an )?(?!.{0,40}\b(?:asky|ask ai|engineering|impact|posthog)\b)/i,
    /system\s*[:>]\s*/i,
    /<\/?\s*system\b/i,
    /jailbreak/i,
    /reveal (?:your |the )?system prompt/i,
  ];
  function preGuard(question) {
    const q = (question || "").trim();
    if (q.length < 4) return { ok: false, reason: "Question is too short." };
    if (q.length > 600) return { ok: false, reason: "Question is too long; please trim to under 600 characters." };
    for (const p of INJECTION_PATTERNS) {
      if (p.test(q)) return { ok: false, reason: "This looks like a prompt-injection attempt. Ask a question about the dataset instead." };
    }
    // Prefix-match: \w* after the alternation lets "impact" cover "impactful/impacts",
    // "engineer" cover "engineers/engineering", "review" cover "reviews/reviewer/reviewing",
    // "ship" cover "shipped/shipping", etc. Without this the seed question
    // "Who are the top 5 most impactful engineers..." was being blocked because
    // \bimpact\b doesn't match the word "impactful".
    const SCOPE = /\b(impact|engineer|posthog|review|merged|merge|incident|area|score|rank|composite|leverage|momentum|methodology|signal|weight|weighted|surviving|survives|centrality|graph|ship|author|authored|fix|fixes|hotfix|regression|outage|carries|on-call|oncall|accelerat|cool(?:ing|ed)?|metric|formula|webjunkie|dmarticus|mattpua|haacked|andrewm|pauldambra|sampennington|rafaeelaudibert|jonmcwest|skoob13|mattbro|dmarchuk|pull\s+request|pull\s+requests)\w*/i;
    if (!SCOPE.test(q)) {
      return { ok: false, reason: "I can only answer questions about engineers, impact, and the data on this page. Try one of the suggested questions on the right." };
    }
    return { ok: true, sanitized: q };
  }

  // Hallucination containment is upstream: the Researcher only selects logins that
  // exist in the dataset, the Analyst only sees that filtered slice, and the system
  // prompts forbid inventing handles. We deliberately do not run a post-hoc regex
  // check on the answer — those false-positive on English words like "touched" or
  // "shipped", which the Analyst legitimately uses without referring to a person.

  // ---------- rephrase suggestion (used after a validation block) ----------
  //
  // When pre-guard or pipeline validation blocks a question, we don't just shrug —
  // we point the user at a precise question that we KNOW can be answered from the
  // live dataset, with real handles baked in (never invented). The intent: high
  // accuracy (every suggestion maps to data fields that exist) and high precision
  // (the suggestion is specific, not "ask something about engineers").
  function suggestRephrase(question, STATE) {
    const q = (question || "").toLowerCase();
    const core = STATE.core || {};
    const top5 = core.top5 || [];
    const swap = (core.by_pr_count || []).find(x => (x.delta || 0) > 1);
    const topName = top5[0]?.login;
    const accel = (core.movers?.accelerating || [])[0]?.login;

    if (/\b(top|best|most|leader(?:s)?\b|impact|driver|standout)/i.test(q)) {
      return "Who are the top 5 most impactful engineers and what makes each one impactful?";
    }
    if (/\b(why|rank(?:s|ing)?|expected|surpris)/i.test(q) && swap) {
      return `Why does ${swap.login} rank lower than expected given his PR volume?`;
    }
    if (/\b(incident|bug|on.?call|hotfix|outage|fire|p[01]\b|sev)/i.test(q)) {
      return "Who carries the on-call / incident-response load?";
    }
    if (/\b(area|owner|product|domain|team|risk|concentrat|bus.?factor)/i.test(q)) {
      return "Who leads each product area, and is any area concentrated enough to be a risk?";
    }
    if (/\b(review)/i.test(q)) {
      return "Who reviews substantially more than they ship?";
    }
    if (/\b(momentum|accelerat|cool(?:ing)?|trend|recent|velocity|cadence|lately|this week)/i.test(q)) {
      return "Which engineers are accelerating in the last 7 days vs cooling off?";
    }
    // If the user mentioned a specific engineer that exists, suggest a deep-dive on them.
    const mentioned = (top5.map(e => e.login) || []).find(l => q.includes(l.toLowerCase()));
    if (mentioned) return `Tell me more about ${mentioned} and what they shipped.`;
    // Default: deep-dive on the current #1.
    if (topName) return `Tell me more about ${topName} and what they shipped.`;
    if (accel)   return `Why is ${accel} accelerating in the last 7 days?`;
    return null;
  }

  // ---------- LangSmith tracing (REST, optional, provider-agnostic) ----------

  async function lsCreateRun(parentRunId, name, inputs, runType="llm", extra={}) {
    const key = getKey(KS.langsmith);
    if (!key) return null;
    const id = crypto.randomUUID();
    const project = getKey(KS.project) || "posthog-impact-askai";
    const body = {
      id, name, run_type: runType, project_name: project,
      inputs: { ...inputs, ...extra },
      start_time: new Date().toISOString(), parent_run_id: parentRunId || undefined,
      extra: { provider: activeProvider(), model: activeModel() },
    };
    try {
      await fetch(LANGSMITH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key },
        body: JSON.stringify(body),
      });
    } catch (e) { /* non-fatal */ }
    return id;
  }
  async function lsEndRun(id, outputs, error) {
    const key = getKey(KS.langsmith);
    if (!key || !id) return;
    try {
      await fetch(`${LANGSMITH_URL}/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-api-key": key },
        body: JSON.stringify({
          end_time: new Date().toISOString(),
          outputs: outputs || undefined,
          error: error || undefined,
        }),
      });
    } catch (e) { /* non-fatal */ }
  }

  // ---------- provider dispatch ----------

  async function llmCall({ system, user, maxTokens=600, expectsJson=false }) {
    const provider = activeProvider();
    const model = activeModel();
    const apiKey = activeProviderKey();
    if (!apiKey) {
      throw new Error(`Add your ${PROVIDERS[provider].label} API key in ⚙ Configure keys to ask live questions.`);
    }
    if (provider === "anthropic") return anthropicCall({ apiKey, model, system, user, maxTokens });
    if (provider === "openai")    return openaiCall({ apiKey, model, system, user, maxTokens, expectsJson });
    if (provider === "gemini")    return geminiCall({ apiKey, model, system, user, maxTokens, expectsJson });
    throw new Error(`Unknown provider: ${provider}`);
  }

  async function anthropicCall({ apiKey, model, system, user, maxTokens }) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model, max_tokens: maxTokens, system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`Anthropic ${r.status}: ${t.slice(0, 300)}`);
    }
    const j = await r.json();
    return (j.content || []).map(c => c.text || "").join("");
  }

  async function openaiCall({ apiKey, model, system, user, maxTokens, expectsJson }) {
    const body = {
      model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user",   content: user },
      ],
    };
    if (expectsJson) body.response_format = { type: "json_object" };
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`OpenAI ${r.status}: ${t.slice(0, 300)}`);
    }
    const j = await r.json();
    return j.choices?.[0]?.message?.content || "";
  }

  async function geminiCall({ apiKey, model, system, user, maxTokens, expectsJson }) {
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        responseMimeType: expectsJson ? "application/json" : "text/plain",
      },
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text();
      // Gemini errors arrive as { error: { code, message, status } } — unwrap for clarity.
      let pretty = t.slice(0, 300);
      try { const e = JSON.parse(t); if (e?.error?.message) pretty = e.error.message; } catch (_) {}
      throw new Error(`Gemini ${r.status}: ${pretty}`);
    }
    const j = await r.json();
    return (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
  }

  // ---------- pipeline ----------

  function compactRoster(STATE) {
    // Send the FULL eligible roster (not a top-N cap). Token-cheap (~7K tokens for
    // 118 engineers) and ensures the Researcher can never miss a mid-rank login
    // the user explicitly asked about.
    const all = (STATE.full && STATE.full.engineers) || (STATE.core.top5 || []);
    return all.map(e => ({
      login: e.login,
      rank: e.rank,
      score: e.score,
      pr_count: e.metrics?.pr_count,
      surviving_code: e.metrics?.surviving_code,
      review_leverage: e.metrics?.review_leverage,
      cross_area: e.metrics?.cross_area,
      incident_work: e.metrics?.incident_work,
      review_centrality: e.metrics?.review_centrality,
      momentum: e.momentum?.label,
      headline: e.headline,
      areas: (e.areas || []).slice(0, 5),
      delta_vs_pr_count: ((STATE.core?.by_pr_count || []).find(x => x.login === e.login) || {}).delta,
    }));
  }

  // Find any engineer login the user explicitly named in their question. Used as a
  // defensive override so the Researcher can never silently drop the subject of the
  // question (e.g. "Why does pauldambra rank lower..." returning 0 logins).
  function loginsMentionedInQuestion(question, knownLogins) {
    const q = (question || "").toLowerCase();
    const hits = new Set();
    for (const login of knownLogins) {
      const lc = login.toLowerCase();
      if (lc.length < 3) continue;
      // Word-bounded against the login charset (letters/digits/hyphen).
      const re = new RegExp(`(^|[^a-z0-9-])${lc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9-]|$)`, "i");
      if (re.test(q)) hits.add(login);
    }
    return hits;
  }

  const RESEARCHER_SYSTEM = `You are the Researcher agent for the PostHog Engineering Impact dashboard.
You receive a user question and a JSON snapshot of the dataset (every eligible engineer, with metrics + momentum + areas + delta_vs_pr_count).

Your job: select the SPECIFIC subset of records and fields that the Analyst will need to answer the question, and return that subset as strict JSON.

Output schema (STRICT, no prose):
{
  "intent": "<one short sentence describing what the user is asking>",
  "selected_logins": ["<login>", ...],
  "fields_needed": ["score", "pr_count", ...],
  "extra_notes": "<one sentence flagging caveats or computations the analyst should do>"
}

Rules:
- Only choose logins that appear in the provided dataset. Never invent handles.
- If the user's question explicitly names one or more engineer logins (e.g. "pauldambra", "webjunkie"), those logins MUST appear in selected_logins — their data is exactly what the Analyst needs, even (especially) when the question is "why does <login> rank lower than expected".
- For broad questions ("top 5 by impact", "who carries on-call") select the relevant 5–10 logins.
- For comparison questions ("X vs Y") include both.
- Keep selected_logins to ≤10. Never return an empty selected_logins array if the question references engineers in any form — pick at least the most relevant 3.`;

  const ANALYST_SYSTEM = `You are the Analyst agent for the PostHog Engineering Impact dashboard.
You receive: the user question, the Researcher's selected slice, and the methodology summary.

Write a SHORT, executive-friendly answer (≤120 words) in markdown. Hard rules:
- Only mention engineer logins that appear in the slice. NEVER invent handles.
- Wrap GitHub logins in backticks: \`webjunkie\`, \`dmarticus\`.
- Cite specific numbers from the slice (e.g., "26 deep reviews", "score 95.7/100").
- End with one short caveat or limitation if relevant.
- No emoji. No headers. Use bullets only when listing >2 items.
- If the question can't be answered from the slice, say so plainly and suggest a question that can.`;

  function methodologySummary() {
    return `Composite impact score = z-score-weighted sum of 5 signals over the last 90 days of merged PRs:
surviving code (25%), review leverage (25%), cross-area reach (15%), incident work (20%), review-graph centrality (15%).
Bots and the 'posthog' service account are excluded; eligibility requires ≥3 merged PRs.
Cross-area excludes config dirs (.github, lockfiles). Incident work uses bug/incident/p0/p1/sev/hotfix/regression/outage labels.
The score is min-max normalized to 0–100 for display.`;
  }

  function setStep(idx, status, note) {
    const li = document.querySelectorAll("#pipeline li")[idx];
    if (!li) return;
    li.querySelector("[data-state]").className = `inline-block w-6 text-center rounded text-[10px] step-${status}`;
    li.querySelector("[data-state]").textContent = status === "ok" ? "✓" : status === "block" ? "✕" : status === "active" ? "…" : "·";
    if (note) li.querySelector("[data-note]").textContent = note;
  }

  function initPipeline() {
    const root = document.getElementById("pipeline");
    root.innerHTML = `
      ${["Pre-guard", "Researcher", "Analyst"].map(name => `
        <li class="flex items-center gap-2">
          <span data-state class="inline-block w-6 text-center rounded text-[10px] step-pending">·</span>
          <span class="font-medium text-slate-700">${name}</span>
          <span data-note class="text-slate-500"></span>
        </li>`).join("")}
    `;
    refreshProviderChip();
  }

  function refreshProviderChip() {
    const chip = document.getElementById("provider-chip");
    if (!chip) return;
    const p = activeProvider();
    const hasKey = !!activeProviderKey();
    chip.textContent = hasKey ? `via ${PROVIDERS[p].label} · ${activeModel()}` : `via ${PROVIDERS[p].label} · key not set`;
    chip.className = `text-[10px] pill ${hasKey ? "text-slate-500" : "text-amber-600"}`;
  }

  function pushBubble(role, html) {
    const chat = document.getElementById("chat");
    const align = role === "user" ? "items-end" : "items-start";
    const bg = role === "user" ? "bg-slate-900 text-white" : (role === "system" ? "bg-rose-50 border border-rose-200 text-rose-800" : "bg-slate-100 text-slate-900");
    chat.insertAdjacentHTML("beforeend", `
      <div class="flex flex-col ${align}">
        <div class="${bg} rounded-2xl px-3.5 py-2.5 max-w-[88%] text-sm md leading-relaxed">${html}</div>
      </div>`);
    chat.scrollTop = chat.scrollHeight;
  }

  function safeMd(s) {
    return s
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" class="text-blue-700 underline">$1</a>')
      .replace(/^- (.+)$/gm, "• $1")
      .replace(/\n/g, "<br>");
  }

  // ---------- run pipeline ----------

  async function ask(question, STATE) {
    if (state.busy) return;
    state.busy = true;
    initPipeline();

    pushBubble("user", safeMd(question));
    const placeholder = document.createElement("div");
    placeholder.className = "text-xs text-slate-500 italic";
    placeholder.textContent = `Ask AI is thinking — running ${PROVIDERS[activeProvider()].label}…`;
    document.getElementById("chat").appendChild(placeholder);

    const traceRoot = await lsCreateRun(null, "askai.pipeline", { question }, "chain");

    try {
      // 1) Pre-guard
      setStep(0, "active");
      const pg = preGuard(question);
      if (!pg.ok) {
        setStep(0, "block", pg.reason);
        placeholder.remove();
        const suggestion = suggestRephrase(question, STATE);
        const tail = suggestion ? `\n\n**Try this instead — it's answerable from the live data:**\n"${suggestion}"` : "";
        pushBubble("system", `**Blocked by pre-guard.** ${safeMd(pg.reason)}${safeMd(tail)}`);
        await lsEndRun(traceRoot, { blocked: pg.reason, suggestion });
        return;
      }
      setStep(0, "ok", "scope + injection ok");

      // 2) Researcher
      setStep(1, "active");
      const slice = compactRoster(STATE);
      const researcherUser = `Question: ${pg.sanitized}\n\nDataset (top 50, JSON):\n${JSON.stringify(slice)}`;
      const rRun = await lsCreateRun(traceRoot, "researcher", { question: pg.sanitized, slice_size: slice.length });
      let researcherJson;
      try {
        const raw = await llmCall({ system: RESEARCHER_SYSTEM, user: researcherUser, maxTokens: 400, expectsJson: true });
        const match = raw.match(/\{[\s\S]*\}/);
        researcherJson = match ? JSON.parse(match[0]) : null;
        if (!researcherJson || !Array.isArray(researcherJson.selected_logins)) throw new Error("Researcher returned invalid JSON.");
        await lsEndRun(rRun, researcherJson);
      } catch (e) {
        setStep(1, "block", e.message);
        await lsEndRun(rRun, null, String(e));
        throw e;
      }
      setStep(1, "ok", `${researcherJson.selected_logins.length} logins · ${researcherJson.fields_needed?.length ?? 0} fields`);

      // 3) Analyst
      setStep(2, "active");
      const selectedSet = new Set(researcherJson.selected_logins.map(s => s.toLowerCase()));

      // Defensive override: any engineer login the user EXPLICITLY named in the
      // question must be in the slice, even if the Researcher missed them. Without
      // this, a question like "Why does pauldambra rank lower than expected..."
      // could return an empty slice and the Analyst would say "no records found".
      const knownLogins = (slice.map(e => e.login)) || [];
      const mentioned = loginsMentionedInQuestion(question, knownLogins);
      let forcedAdditions = [];
      for (const login of mentioned) {
        if (!selectedSet.has(login.toLowerCase())) {
          selectedSet.add(login.toLowerCase());
          forcedAdditions.push(login);
        }
      }

      const filteredSlice = slice.filter(e => selectedSet.has(e.login.toLowerCase()));

      // If the slice is STILL empty (rare edge case: vague question, no name, no
      // researcher hit), fall back to the top-5 by impact so the Analyst at least
      // has something concrete to ground in.
      if (filteredSlice.length === 0) {
        const top5 = slice.slice(0, 5);
        for (const e of top5) {
          selectedSet.add(e.login.toLowerCase());
          filteredSlice.push(e);
        }
        forcedAdditions = forcedAdditions.concat(["<top5 fallback>"]);
      }
      const analystUser = `Question: ${pg.sanitized}

Methodology summary:
${methodologySummary()}

Researcher intent: ${researcherJson.intent || "—"}
Researcher notes: ${researcherJson.extra_notes || "—"}

Selected slice (use ONLY these records):
${JSON.stringify(filteredSlice, null, 0)}`;
      const aRun = await lsCreateRun(traceRoot, "analyst", { question: pg.sanitized, slice_size: filteredSlice.length, forced_additions: forcedAdditions });
      const answer = await llmCall({ system: ANALYST_SYSTEM, user: analystUser, maxTokens: 600 });
      await lsEndRun(aRun, { answer_chars: answer.length });
      if (!answer || !answer.trim()) {
        setStep(2, "block", "empty answer from model");
        placeholder.remove();
        const suggestion = suggestRephrase(question, STATE);
        const tail = suggestion ? `\n\n**Try this instead — it's answerable from the live data:**\n"${suggestion}"` : "";
        pushBubble("system", `**Empty answer from the model.**${safeMd(tail)}`);
        await lsEndRun(traceRoot, { blocked: "empty answer", suggestion });
        return;
      }
      setStep(2, "ok", `${answer.split(/\s+/).length} words`);

      placeholder.remove();
      pushBubble("assistant", safeMd(answer));
      await lsEndRun(traceRoot, { answer });
    } catch (e) {
      placeholder.remove();
      const suggestion = suggestRephrase(question, STATE);
      const tail = suggestion ? `\n\n**Try this instead — it's answerable from the live data:**\n"${suggestion}"` : "";
      pushBubble("system", `**Error.** ${safeMd(e.message || String(e))}${safeMd(tail)}`);
      await lsEndRun(traceRoot, null, String(e));
    } finally {
      state.busy = false;
    }
  }

  // ---------- key modal ----------

  function syncModalToProvider() {
    const sel = document.getElementById("provider-select");
    const provider = sel.value;
    const cfg = PROVIDERS[provider];
    document.getElementById("provider-key-label").textContent = cfg.keyLabel;
    const keyInput = document.getElementById("provider-key");
    keyInput.placeholder = cfg.keyPrefix + "...";
    keyInput.value = getKey(cfg.keyStorage);
    const modelInput = document.getElementById("provider-model");
    modelInput.placeholder = cfg.defaultModel;
    modelInput.value = getKey(cfg.modelStorage);
  }

  function openKeyModal() {
    document.getElementById("provider-select").value = activeProvider();
    syncModalToProvider();
    document.getElementById("langsmith-key").value = getKey(KS.langsmith);
    document.getElementById("langsmith-project").value = getKey(KS.project) || "posthog-impact-askai";
    const modal = document.getElementById("key-modal");
    modal.classList.remove("hidden"); modal.classList.add("flex");
  }
  function closeKeyModal() {
    const modal = document.getElementById("key-modal");
    modal.classList.add("hidden"); modal.classList.remove("flex");
  }

  function init(STATE) {
    if (state.initialized) return;
    state.initialized = true;
    initPipeline();

    // Suggested questions — clicking pre-fills the input. We never render canned answers.
    const seedRoot = document.getElementById("seed-questions");
    seedRoot.innerHTML = (STATE.core.suggested_questions || []).map(q =>
      `<button class="block w-full text-left text-xs px-2.5 py-1.5 rounded-lg bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200" data-q="${q.replace(/"/g, '&quot;')}">${q}</button>`
    ).join("");
    seedRoot.querySelectorAll("button[data-q]").forEach(b => b.addEventListener("click", () => {
      document.getElementById("chat-input").value = b.dataset.q;
      document.getElementById("chat-input").focus();
    }));

    // Modal wiring
    document.getElementById("key-btn").addEventListener("click", openKeyModal);
    document.getElementById("key-cancel").addEventListener("click", closeKeyModal);
    document.getElementById("provider-select").addEventListener("change", syncModalToProvider);
    document.getElementById("key-clear").addEventListener("click", () => {
      // Clear ONLY the active provider's key + model. LangSmith stays.
      const provider = document.getElementById("provider-select").value;
      const cfg = PROVIDERS[provider];
      setKey(cfg.keyStorage, "");
      setKey(cfg.modelStorage, "");
      syncModalToProvider();
    });
    document.getElementById("key-save").addEventListener("click", () => {
      const provider = document.getElementById("provider-select").value;
      const cfg = PROVIDERS[provider];
      setKey(KS.provider, provider);
      setKey(cfg.keyStorage, document.getElementById("provider-key").value.trim());
      setKey(cfg.modelStorage, document.getElementById("provider-model").value.trim());
      setKey(KS.langsmith, document.getElementById("langsmith-key").value.trim());
      setKey(KS.project, document.getElementById("langsmith-project").value.trim());
      refreshProviderChip();
      closeKeyModal();
    });

    // Form
    document.getElementById("chat-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const input = document.getElementById("chat-input");
      const q = input.value.trim();
      if (!q) return;
      input.value = "";
      ask(q, STATE);
    });

    // Welcome message — no canned answer, just orientation.
    if (!document.getElementById("chat").children.length) {
      pushBubble(
        "assistant",
        "Hi — I'm Ask AI. I run a 3-step pipeline (Pre-guard → Researcher → Analyst) over the live data on this page. Pick a provider (Anthropic / OpenAI / Gemini) and add your key under <code>⚙ Configure keys</code>, then click any suggested question on the right or type your own. Every answer is grounded in the precomputed dataset — the Researcher narrows to the engineers that matter for your question, then the Analyst writes the response using only that slice."
      );
    }
  }

  window.AskAI = { init, ask };
})();
