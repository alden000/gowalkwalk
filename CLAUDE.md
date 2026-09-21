# Working agreements for GoWalkWalk

Two standing rules, set by the project owner. They are not optional and they
are not a checklist to mention — they are a checklist to *run*.

---

## 1. Every code change ends in a QA pass

Think like the QA engineer who has to sign the release, not like the developer
who wants the change to be finished. The question is never "does it work?" — it
is "what would make this fail in someone's hands, on a trail, with one bar of
signal?"

Run these in order. Do not skip a step because the change looks small; the
shadowed-variable bug that broke every OpenStreetMap query looked like a
two-line refactor.

**a. Static check.** `node --check` every JavaScript file touched. Catches
syntax and, in modules, a surprising amount else.

**b. The full suite, every time.**

```sh
npm --prefix test install            # once
npx playwright install chromium      # once, or set CHROME_PATH
node test/e2e.js
```

The whole suite, not the part you think is affected. It runs in about a minute
and it exists precisely because the failure you did not predict is the one that
matters. Report the count as it came back — `53/53`, not "tests pass".

**c. Extend the suite with the change.** Every bug fixed gets a check that
**fails without the fix**. Every feature added gets a check that exercises it
the way a person would, through the UI, not by calling the function. Verify the
new check actually fails against the old code where that is cheap to do — a
check that passes either way proves nothing.

**d. Adversarial re-read of your own diff.** Read it as a reviewer looking for
a reason to reject it. Specifically: what happens on the empty case, the huge
case, the offline case, the second route, the slow server, the cancelled
action? Fix what you find before running the suite again.

**e. Reality check on anything external.** If the change touches an outside
service — Overpass, Open-Meteo, NEA, tiles, Commons — exercise the *real*
endpoint once (curl is fine) and confirm the request shape and the response
shape are what the code assumes. Stubs prove the app's logic; only the real
service proves the contract. Note that `overpass-api.de` is frequently
unreachable from here while the mirrors answer — that is data, not a blocker.

**f. See it, at phone size.** Any change with a visible effect gets a
screenshot at a real handset viewport (390×844, DPR 2) and gets *looked at* —
both states of anything that toggles. A layout that only exists in your head
has not been tested.

**g. Offline and the service worker.** New or renamed files go in `SHELL` in
`sw.js`, and `VERSION` gets bumped whenever shipped files change, or installed
copies keep serving the old app. The suite's offline check must still pass.

**h. Say what actually happened.** Report the numbers, name anything skipped
and why, and never describe an untested change as verified.

---

## 2. UI and UX changes get a design director's judgement

When a change needs interface design, do not reach for the nearest control that
would work. Approach it as a senior creative director would: understand the
moment, propose deliberately, and justify the choice.

**Know the user and the moment.** This app is used outdoors, one-handed, on a
phone that is also the map, the torch and the way home. Assume: bright sun on a
dim screen, a hand that is wet or gloved, a battery the walker is rationing, an
interruption every few minutes, and — the moment the app exists for — someone
who needs an AED *now* and is not in a mood to learn an interface.

**Then design, properly.**

- **Start from the job**, not the widget. "They are waiting and cannot tell if
  it is broken" is a brief. "Add a spinner" is not.
- **Bring two or three real options** with the trade-off each makes, then make
  a clear recommendation and say why. Do not present a menu and ask the owner
  to design it.
- **Interaction flow before pixels.** Where does the walker come from, what
  decides the next step, what happens when it fails, and how do they get out?
  Every wait is cancellable and says what it is waiting for. Every dead end has
  a door.
- **Ergonomics are not decoration.** Primary actions in the thumb arc at the
  bottom; the destructive and the irreversible out of it. Touch targets no
  smaller than 44 px. Nothing important behind a hover, a long-press or a
  gesture with no visible affordance. Text that survives sunlight and a
  squint — no 10 px grey on grey for anything that matters.
- **Earn every pixel of the map.** The map is the product. A panel that is not
  actively being read gets out of its way, while whatever must stay visible —
  progress, a weather warning — survives the collapse.
- **State is information.** "Nothing found" is a finding and must be said, not
  rendered as an empty box. A stale number says how old it is. An estimate says
  it is one.
- **One voice.** Plain, calm, specific. It tells the walker what is true and
  what to do; it never blames them, and it never says "Oops".
- **Match what is there.** This app has a visual language — dark panels, one
  accent green, orange for the route ahead, the reference app's typography and
  spacing. A new element joins it rather than introducing a second style.

**Then QA it** under rule 1, screenshot included.
