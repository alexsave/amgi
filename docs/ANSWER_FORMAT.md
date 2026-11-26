# Why the model answers in JSON

Decision, 2026-11-08: the card-text call and the judge calls ask Gemini for JSON (`response_mime_type` application/json plus a response JSON schema) and parse the answer.
This is a recorded exception to the rule that amgi's own data paths carry no JSON.
The model's answer is text the vendor's decoder produces, and JSON mode is the format that decoder enforces best.

## What was tried

Three ways to get the card's fields back, on the same model (`gemini-3.8-flash`, thinking LOW), over gRPC.
Normal inputs are 120 phrases (the 10 starter phrases in 12 language pairs).
Stress inputs are about 40 adversarial lines: label look-alikes, colons, quotes, emoji, a very long line, mixed scripts, a line already in the target language.
Latency was measured with 12 to 40 requests in flight, so the tail is pessimistic next to the app's 5 lanes.

| | JSON mode | Forced function calling | Labelled lines |
|---|---|---|---|
| First-try parse, normal and stress | 100% | 100% | 100% |
| Dollars per card, normal | 0.00087 | 0.00113 (+31%) | 0.00125 (+44%) |
| Dollars per card, stress | 0.00114 | 0.00161 (+42%) | 0.00269 (+137%) |
| Median latency | 2.19 s | 2.17 s | 2.35 s |
| p95 latency, normal / stress | 3.7 s / 8.1 s | 4.7 s / 8.7 s | 6.1 s / 26.7 s |
| Thinking tokens per card, normal | 16 | 22 | 110 |
| Agreement with JSON (JSON with itself: 67 to 73%) | - | about 60% | about 52% |
| Judge calls (50 cases) | baseline | same verdict on 50 of 50, +49% cost | not run |

## Why JSON mode

The API enforces the schema while it decodes, so the model does not spend thinking on the format.
The schema is not billed as prompt tokens.
It is the smallest hand-written protobuf surface: two request fields (13 and 28) and one parse of about 60 bytes.

## Why not function calling

It parsed perfectly, but it cost about 31% more per card and 49% more per judge call, with nothing gained.
The function declaration is billed as prompt tokens (1,095 against 779 per call).
The model thinks about twice as much, and the tail is worse: p95 4.7 s against 3.7 s, and one request took 29.6 s.
It adds about 170 lines of hand-written protobuf (Schema, FunctionDeclaration, Tool, ToolConfig, FunctionCall, Struct) and its own failure cases, each a place a field renumbering or a model change can break.
Both judges gave the same verdicts as JSON on all 50 cases, so there was no accuracy gain.
Dropping the argument descriptions cut the extra cost to about 17%, which is still more than JSON.

## Why not labelled lines

It parsed perfectly too, but nothing in the API enforces the format, so the model thinks far more: 91 of 159 cards used thinking, against 11 of 160 for JSON.
That is +44% per card on normal inputs, +137% on stress inputs, and a 26.7 s p95 on stress.

## What would change this

- A JSON-mode run of about 1,000 cards that shows any parse failure or schema violation.
- Google billing for, deprecating or changing `response_json_schema`.
- A need for multi-turn tool use, such as the model asking for a dictionary lookup.
- A function declaration without argument descriptions measured at parity on the full set.
- A format instruction in the system prompt: it cut thinking from a mean of about 570 to about 88 tokens on 8 stress inputs under function calling, and was never run on normal inputs.

## Limits of the measurement

One model, one thinking level, 120 normal and about 40 stress inputs per variant.
The agreement differences between variants are within about 1.3 standard errors of the model's own run-to-run noise.
A thinking budget parameter made thinking worse: 3.8 Flash does not treat it as a cap.
