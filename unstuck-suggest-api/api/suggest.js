// Serverless proxy for the "Unstuck" prototype's "Suggest me with AI" button.
// Keeps ANTHROPIC_API_KEY server-side — the GitHub Pages frontend never sees it.
//
// Not a hardened public API: PROTO_TOKEN is a casual deterrent (visible in the
// frontend JS bundle, so not real auth), plus a best-effort in-memory rate limit
// that only helps within a single warm serverless instance. Fine for an internal
// team-testing prototype; revisit (proper auth + Upstash/Redis rate limiting) if
// this goes beyond that.

const ALLOWED_ORIGIN = "https://igormscaldini.github.io";
const PROTO_TOKEN = "Vb2jxJSOSr2RwZxEy12jgJhECuYnzVsm";
const MAX_TASK_LENGTH = 500;
const MAX_HISTORY_ITEMS = 15;
const MAX_HISTORY_ITEM_LENGTH = 300;
const MODEL = "claude-haiku-4-5-20251001";

// Best-effort in-memory rate limit (per warm instance only).
const hits = new Map(); // ip -> [timestamps]
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 6;

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > MAX_PER_WINDOW;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Proto-Token");
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (req.headers["x-proto-token"] !== PROTO_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  if (rateLimited(ip)) {
    res.status(429).json({ error: "Too many requests — slow down a bit and try again." });
    return;
  }

  const task = (req.body && req.body.task ? String(req.body.task) : "").trim();
  if (!task) {
    res.status(400).json({ error: "Missing task" });
    return;
  }
  if (task.length > MAX_TASK_LENGTH) {
    res.status(400).json({ error: "Task description too long" });
    return;
  }

  const previousActions = Array.isArray(req.body && req.body.previousActions)
    ? req.body.previousActions
        .filter((a) => typeof a === "string" && a.trim())
        .map((a) => a.trim().slice(0, MAX_HISTORY_ITEM_LENGTH))
        .slice(-MAX_HISTORY_ITEMS)
    : [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server not configured" });
    return;
  }

  const system =
    "You help someone who is procrastinating find ONE small thing they could do in the next 10 " +
    "minutes about a task they describe. Assume the person has some baseline capability and can " +
    "handle producing a small amount of real work — not just a single trivial warm-up action — " +
    "but they currently have LOW motivation and may not have all the specifics loaded in their " +
    "head, so avoid asking them to make big judgment calls, weigh priorities among many options, " +
    "or draw on specialized knowledge they may not have.\n\n" +
    "If the person has already completed earlier steps on this same task (given below), suggest " +
    "the NEXT logical step that builds on that progress — don't repeat what they already did or " +
    "suggest something disconnected from it.\n\n" +
    "Hard rules for the suggestion:\n" +
    "- It must not require weighing multiple priorities or specialized expertise (e.g. never " +
    "\"list the 3-5 key topics that matter most\" — deciding what matters most is often the hard " +
    "part they're stuck on).\n" +
    "- It's fine for the suggestion to ask for a bit of real, rough output — a short paragraph, a " +
    "few bullet points, a first pass at something — as long as it's clearly low-stakes, " +
    "reversible, and doesn't require them to already know the \"right\" answer.\n" +
    "- If the task involves specialized/technical content the person may not have memorized, " +
    "suggest reviewing/skimming existing material rather than producing new expert content from " +
    "memory.\n" +
    "- A good test: could someone with only casual familiarity with this task start doing this " +
    "within a few seconds of reading it, and finish in well under 10 minutes without needing " +
    "outside expertise?\n\n" +
    "Examples (BAD = too big/assumes expertise, TOO TINY = undersized, don't do this either, " +
    "GOOD = right-sized):\n" +
    "Task: \"Preparing slides for Thursday's board meeting\"\n" +
    "  BAD: \"List the 3-5 key topics you need to cover and create a blank slide for each.\"\n" +
    "  TOO TINY: \"Open a blank slide deck and just type the meeting title on slide one.\"\n" +
    "  GOOD: \"Open a blank slide deck, type the meeting title on slide one, and add 2-3 more " +
    "slides with rough placeholder headers for whatever topics come to mind first — they don't " +
    "need to be right.\"\n" +
    "Task: \"Writing the first draft of a quarterly report for my manager\"\n" +
    "  BAD: \"Write the Executive Summary with 3-4 bullet points of your biggest accomplishments.\"\n" +
    "  TOO TINY: \"Open a blank document and write one rough sentence about what this report is " +
    "about.\"\n" +
    "  GOOD: \"Open a blank document and write a rough 3-4 sentence paragraph about what this " +
    "report covers and why — it's fine if it's messy, you can fix it later.\"\n" +
    "Task: \"Studying for my chemistry exam next week\"\n" +
    "  BAD: \"Write out the electron configurations for the first 20 elements.\"\n" +
    "  TOO TINY: \"Open your chemistry notes or textbook and reread just the first page.\"\n" +
    "  GOOD: \"Open your chemistry notes or textbook and skim the next 2-3 pages, jotting down " +
    "anything that looks unfamiliar.\"\n\n" +
    "Judge BROAD only when the description gives you almost nothing to work with (e.g. single " +
    "vague words or phrases like \"life stuff\", \"my project\", \"work\", \"that thing\", " +
    "\"school\"). If the task names a specific deliverable, person, deadline, event, or subject " +
    "matter — even briefly — treat it as OK, not BROAD, even if some details are still unstated.\n\n" +
    "Respond in EXACTLY this two-line format, nothing else, no markdown:\n" +
    "Line 1: the single word OK, or the single word BROAD.\n" +
    "Line 2: one or two short sentences, written as a direct instruction telling them what to do " +
    "(never a question, never a request for more detail, never \"it depends\" or similar hedging) " +
    "— the suggested action, following the hard rules above. Even if line 1 is BROAD, you MUST " +
    "still invent a concrete, reasonable, generic best-guess action on line 2 — do not ask a " +
    "clarifying question and do not refuse.";

  let userContent = `Task: ${task}`;
  if (previousActions.length) {
    const steps = previousActions.map((a, i) => `${i + 1}. ${a}`).join("\n");
    userContent += `\n\nSteps already completed on this task, in order (most recent last):\n${steps}`;
  }

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 220,
        system,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error("Anthropic API error", upstream.status, errText);
      res.status(502).json({ error: "AI suggestion failed — try describing it yourself." });
      return;
    }

    const data = await upstream.json();
    const raw = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    let tooBroad = false;
    let suggestion = raw;
    if (lines.length >= 2 && /^(OK|BROAD)$/i.test(lines[0])) {
      tooBroad = /^BROAD$/i.test(lines[0]);
      suggestion = lines.slice(1).join(" ");
    }

    res.status(200).json({ suggestion, tooBroad });
  } catch (err) {
    console.error("suggest.js error", err);
    res.status(500).json({ error: "AI suggestion failed — try describing it yourself." });
  }
};
