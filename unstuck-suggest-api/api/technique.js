// Serverless proxy for the "Unstuck" prototype's "Personalize with AI" button on the
// pre-task cause/technique step. Keeps ANTHROPIC_API_KEY server-side.
//
// See the comment at the top of suggest.js for the current (deliberately lightweight)
// abuse-mitigation approach — same tradeoffs apply here.

const ALLOWED_ORIGIN = "https://igormscaldini.github.io";
const PROTO_TOKEN = "Vb2jxJSOSr2RwZxEy12jgJhECuYnzVsm";
const MAX_CONTEXT_LENGTH = 300;
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

// Mirrors the causes/techniques shown in the frontend (index.html CAUSES array),
// grounded in the same research base as Clearer Thinking's "Get Going" course.
const CAUSES = {
  fear: {
    title: "fear of failure / self-doubt",
    grounding:
      "The R.A.I.N. method (Recognize, Acknowledge, Investigate, Non-identify; Salzberg, 2017) and " +
      "mindfulness research linking mindfulness to lower procrastination (Schutte & del Pozo de " +
      "Bolger, 2020). Core idea: name the feeling, accept it without judgment, and remember " +
      "self-limiting thoughts are not facts you have to obey.",
  },
  motivation: {
    title: "lack of motivation",
    grounding:
      "Milestone-setting and research on temporal discounting (Green & Myerson, 2004; Steel et al., " +
      "2018): distant rewards feel less valuable than near ones, so vividly imagining the payoff and " +
      "shrinking the goal down to a tiny, near-term next step restores motivation.",
  },
  fatigue: {
    title: "mental fatigue / low energy",
    grounding:
      "Research on mental fatigue and procrastination (Kachgal, Hansen, & Nutter, 2001) and the " +
      "ego-depletion literature: being tired makes tasks feel more aversive and makes people more " +
      "impulsive. A brief physical reset (movement, breathing, hydration) before starting helps.",
  },
  distraction: {
    title: "trouble staying focused / distractions",
    grounding:
      "Research on attention residue (Leroy, 2009) and precommitment strategies (the Odysseus-and-" +
      "the-Sirens idea): removing a likely distraction BEFORE starting, rather than relying on " +
      "willpower once tempted, works better.",
  },
  unsure: {
    title: "an unclear mix of causes",
    grounding:
      "A blend of mindfulness, precommitment, and milestone-setting techniques, since the exact " +
      "cause isn't clear yet.",
  },
};

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

  const causeKey = req.body && typeof req.body.cause === "string" ? req.body.cause : "";
  const cause = CAUSES[causeKey] || CAUSES.unsure;

  const context = (req.body && req.body.context ? String(req.body.context) : "")
    .trim()
    .slice(0, MAX_CONTEXT_LENGTH);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server not configured" });
    return;
  }

  const system =
    "You give someone exactly ONE brief technique they can do in about a minute, right now, to get " +
    "past a moment of procrastination. Their procrastination is likely caused by: " + cause.title + ".\n\n" +
    "Ground your suggestion in this research: " + cause.grounding + "\n\n" +
    "Rules:\n" +
    "- 2-3 short sentences, second person, written as direct instructions (not questions).\n" +
    "- It must be doable in about a minute, before they've even named the task they're avoiding.\n" +
    "- No markdown, no citations or references in the output itself, no preamble like \"Sure, here's...\".\n" +
    "- If the person gave optional context about their situation, tailor the technique to it — but " +
    "never ask a clarifying question back, just give the technique.";

  const userContent = context
    ? "Optional context from the person about what's making it hard to start: " + context
    : "No additional context given — give a solid general version of the technique.";

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
        max_tokens: 150,
        system,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error("Anthropic API error", upstream.status, errText);
      res.status(502).json({ error: "AI personalization failed — the technique above still works." });
      return;
    }

    const data = await upstream.json();
    const technique = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    res.status(200).json({ technique });
  } catch (err) {
    console.error("technique.js error", err);
    res.status(500).json({ error: "AI personalization failed — the technique above still works." });
  }
};
