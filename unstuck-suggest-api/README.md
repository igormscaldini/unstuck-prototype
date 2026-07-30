# unstuck-suggest-api

Tiny serverless proxy for the "Unstuck" procrastination-tool prototype (hosted on GitHub Pages at
https://igormscaldini.github.io/unstuck-prototype/).

Holds `ANTHROPIC_API_KEY` server-side so the static GitHub Pages frontend never exposes it. The
frontend's "Suggest me with AI" button calls `POST /api/suggest` here with `{ "task": "..." }` and
gets back `{ "suggestion": "...", "tooBroad": true|false }`.

Not hardened for public use beyond this — see the comment at the top of `api/suggest.js` for the
current (deliberately lightweight) abuse-mitigation approach and what to upgrade if this goes
beyond internal team testing.

Deploy: `npx vercel --prod` (from this directory). Requires the `ANTHROPIC_API_KEY` env var to be
set on the Vercel project.
