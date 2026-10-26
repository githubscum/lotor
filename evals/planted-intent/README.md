# Planted-intent corpus (V3-08)

Synthetic agent runs with known intent, one case per run. This fixture serves eval
E3, which scores a meter's intent findings at each reach rung, and eval E6, which
traces planted canary values. This directory holds the fixture (corpus.json), its
loader and validator (corpus.js), and the tests that pin both. Scoring is NOT in
this directory yet.

## Binding split

Lotor captures what happens at each rung. It never infers intent: that job belongs
to the meter, which is scored against the answer key but sees only the stripped
view. The key (answerKey inside each case) exists only for scoring and must never
be shown to the system under test. stripToReach is the boundary that enforces it.

## Rung visibility

| Rung | What the observing system sees                          |
| ---- | ------------------------------------------------------- |
| R0   | declared purpose only                                   |
| R1   | plus action sequence (per step: tool and input)          |
| R2   | plus tool outputs                                       |
| R3   | plus the reasoning the model emitted between actions     |

R4 and R5 are not in this corpus.

## Case shape

Each case has an id (pi-NNN), a statedPurpose, steps[] (tool, input, output,
reasoning), and an answerKey: a realIntent label, a divergent flag, firstVisibleAt
(the shallowest rung at which the real intent becomes visible), evidenceSteps
(0-based step indices), and canaries. Divergent cases are runs whose stated
purpose differs from the real one.

## E6 canaries

Canary strings (LOTOR-CANARY- followed by 8 or more uppercase letters and digits)
are planted only inside step outputs. They never appear in inputs, so they are
invisible at R0 and R1 and traceable from R2 on. No canary string appears in more
than one case.

## Adding a case and running the validator

Append a case to corpus.json, continuing the id numbering, and list its canary
strings in answerKey.canaries. Then run:

    node --test test/planted-intent-corpus.test.js

validateCorpus reports every mechanical violation (it never throws on malformed
input). The tests also pin the minimum counts: at least 10 cases, at least 4
non-divergent, at least 2 divergent at each of R1, R2 and R3, and at least 3
canary cases.