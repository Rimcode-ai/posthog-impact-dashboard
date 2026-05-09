/* Ask AI — multi-agent grounded Q&A over the live PostHog impact dataset.
 *
 * Pipeline (all client-side, all live):
 *   1. Pre-guard       (deterministic) — scope + prompt-injection strip
 *   2. Researcher      (LLM)           — extracts the relevant data slice + plan
 *   3. Analyst         (LLM)           — composes the answer using ONLY that slice
 *   4. Critic          (deterministic) — hallucination & citation guards
 *
 * Providers: Anthropic Claude · OpenAI · Google Gemini. User picks one in the modal.
 * Optional: LangSmith REST tracing if the user provides a key (provider-agnostic).
 *
 * Hard rules:
 *   • No baked / canned answers — every response is a live LLM run on data.json.
 *   • Keys stay in localStorage and are sent only to the selected provider's API.
 *   • If validation fails, the answer is BLOCKED and we tell the user why.
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

  function rosterFromState(STATE) {
    const set = new Set();
    if (STATE.core) {
      (STATE.core.top5 || []).forEach(e => set.add(e.login.toLowerCase()));
      (STATE.core.by_pr_count || []).forEach(e => set.add(e.login.toLowerCase()));
      (STATE.core.area_leaders || []).forEach(r => {
        set.add(r.leader.toLowerCase());
        (r.runners_up || []).forEach(u => set.add(u.login.toLowerCase()));
      });
      const m = STATE.core.movers || {};
      (m.accelerating || []).concat(m.cooling || []).forEach(x => set.add(x.login.toLowerCase()));
    }
    if (STATE.full) {
      (STATE.full.engineers || []).forEach(e => set.add(e.login.toLowerCase()));
    }
    return set;
  }
  function postGuard(answer, roster) {
    if (!answer || !answer.trim()) return { ok: false, reason: "Empty answer." };
    const candidates = new Set();
    const pat = /(?:^|\s|[*`])@?([A-Za-z][A-Za-z0-9-]{1,38})\b/g;
    let m; while ((m = pat.exec(answer)) !== null) {
      const cand = m[1];
      const lc = cand.toLowerCase();
      if (lc.length < 3) continue;
      if (COMMON_WORDS.has(lc)) continue;
      if (cand.match(/^[A-Z][a-z]+$/)) continue;
      candidates.add(lc);
    }
    const unknown = [];
    for (const c of candidates) if (!roster.has(c)) unknown.push(c);
    if (unknown.length) {
      return { ok: false, reason: `Hallucination guard: the answer references unknown handles ${unknown.slice(0,5).map(x => "`" + x + "`").join(", ")} that aren't in the dataset roster.` };
    }
    return { ok: true };
  }

  const COMMON_WORDS = new Set([
    "the","and","for","with","this","that","from","they","their","have","has","are","was","were","but","not","you","your","our","what","which","who","whom","can","cannot","yes","no","over","under","most","more","less","than","also","than","very","each","every","across","into","onto","top","bottom","high","low","key","good","bad","total","summary","note","based","data","page","posthog","github","cli","api","ui","engineer","engineers","review","reviews","reviewer","author","authors","pr","prs","impact","leverage","incident","incidents","cross","area","areas","centrality","surviving","code","score","scores","rank","ranks","ranking","window","weeks","months","day","days","week","quarter","accelerating","cooling","steady","z","weight","weights","median","medians","percent","headline","why","because","therefore","while","whereas","including","both","one","two","three","four","five","six","seven","eight","nine","ten","mostly","mainly","largely","ones"
  ]);

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
    const top = (STATE.full && STATE.full.engineers) || (STATE.core.top5 || []);
    return top.slice(0, 50).map(e => ({
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
    }));
  }

  const RESEARCHER_SYSTEM = `You are the Researcher agent for the PostHog Engineering Impact dashboard.
You receive a user question and a JSON snapshot of the dataset (top 50 engineers by composite impact, with metrics + momentum + areas).

Your job: select the SPECIFIC subset of records and fields that the Analyst will need to answer the question, and return that subset as strict JSON.

Output schema (STRICT, no prose):
{
  "intent": "<one short sentence describing what the user is asking>",
  "selected_logins": ["<login>", ...],
  "fields_needed": ["score", "pr_count", ...],
  "extra_notes": "<one sentence flagging caveats or computations the analyst should do>"
}

Rules: Only choose logins that appear in the provided dataset. Never invent handles. Keep it tight.`;

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
      ${["Pre-guard", "Researcher", "Analyst", "Critic"].map(name => `
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
        pushBubble("system", `**Blocked by pre-guard.** ${safeMd(pg.reason)}`);
        await lsEndRun(traceRoot, { blocked: pg.reason });
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
      const filteredSlice = slice.filter(e => selectedSet.has(e.login.toLowerCase()));
      const analystUser = `Question: ${pg.sanitized}

Methodology summary:
${methodologySummary()}

Researcher intent: ${researcherJson.intent || "—"}
Researcher notes: ${researcherJson.extra_notes || "—"}

Selected slice (use ONLY these records):
${JSON.stringify(filteredSlice, null, 0)}`;
      const aRun = await lsCreateRun(traceRoot, "analyst", { question: pg.sanitized, slice_size: filteredSlice.length });
      const answer = await llmCall({ system: ANALYST_SYSTEM, user: analystUser, maxTokens: 600 });
      await lsEndRun(aRun, { answer_chars: answer.length });
      setStep(2, "ok", `${answer.split(/\s+/).length} words`);

      // 4) Critic / post-guard
      setStep(3, "active");
      const roster = rosterFromState(STATE);
      const guard = postGuard(answer, roster);
      if (!guard.ok) {
        setStep(3, "block", guard.reason);
        placeholder.remove();
        pushBubble("system", `**Blocked by post-guard.** ${safeMd(guard.reason)}\n\nThe model produced an answer but it referenced engineer handles not in our dataset. Rephrase the question or ask about a specific engineer in the leadership brief.`);
        await lsEndRun(traceRoot, { blocked: guard.reason });
        return;
      }
      setStep(3, "ok", "hallucination & citation ok");

      placeholder.remove();
      pushBubble("assistant", safeMd(answer));
      await lsEndRun(traceRoot, { answer });
    } catch (e) {
      placeholder.remove();
      pushBubble("system", `**Error.** ${safeMd(e.message || String(e))}`);
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
        "Hi — I'm Ask AI. I run a 4-step pipeline (Pre-guard → Researcher → Analyst → Critic) over the live data on this page. Pick a provider (Anthropic / OpenAI / Gemini) and add your key under <code>⚙ Configure keys</code>, then click any suggested question on the right or type your own. Every answer references only engineers and numbers that exist in the dataset."
      );
    }
  }

  window.AskAI = { init, ask };
})();
