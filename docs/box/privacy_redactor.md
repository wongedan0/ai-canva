# Privacy Reactor - William Hok (s3783207)

# Sprint 1 Week 1
- [x] Read the "What is AI Canva?" guide
- [x] Read your brief and pick your box / lock your team roles
- [x] Choose your research question and find 3 sources
- [x] Clone the repo and get it running (npm run dev)
- [x] Register your first box in types.ts

## Chosen research question and 3 sources
Is LLM redaction trustworthy vs deterministic tools?
- Coronado-Blázquez, J. (2025). Deterministic or probabilistic? The psychology of LLMs as random number generators. arXiv. https://doi.org/10.48550/arXiv.2502.19965
- Neuman, S., & Fadel, L. (2026, February 6). DOJ admits redaction errors in Epstein docs while names in files face scrutiny. NPR. https://www.npr.org/2026/02/06/nx-s1-5702692/epstein-files-doj-trump-clinton-oversight
- Jathanna, S. V. (2026). SurrogateShield: BeyondRedaction for High-Utility, Privacy-Preserving LLM Interactions. ArXiv. https://doi.org/10.48550/arXiv.2606.29567
- Vats, G., Agrwal, A., Singhal, S., Dash, A., Selvaraj, P., Jhawar, V., Chenna, R. P., & G, B. Y. M. (2026). REDACT: A Systematically Controlled Multilingual Benchmark for Personal Information Detection. arXiv. https://doi.org/10.48550/arXiv.2606.19881

# Sprint 1 Week 2
- [x] Design a reversible redaction map
- [x] Provide a proposed reversible redaction map diagram
- [x] Draft better prompt template
- [x] Start `Is LLM redaction trustworthy vs deterministic tools?` research

## Reversible Redaction Map Design

### Design
The mapping is a flat JSON object, where the key is the placeholder and the value is the original PII string.

For example:
```json
{
  "NAME_1": "John Doe",
  "EMAIL_1": "johndoe@example.com",
  "PHONE_1": "0400 000 000"
}
```

### Where Did the Output Go?
The redacted text still flows downstream to any connected boxes after the "Privacy Redactor" box, such as a "Summarize" box. Meanwhile, the actual PII never flows downstream and is never stored anywhere.

### Storage Decision
The mapping is not stored in Firestore or `localStorage`. It is generated in-memory by the AI call and offered as a one-time downloadable `.txt` file after running the "Privacy Redactor" box. Once downloaded, it exists only on the user's device.

**Rationale:** Storing the mapping server-side means trusting that persistence layer to keep PII safe indefinitely. By not saving the mapping to Google/Firestore, that dependency is removed entirely — no database to secure and no future breach to worry about. The safest place to keep a user's own mapping is the user's own device.

**Trade-off:** if the user does not download the mapping before re-running the box or closing the page, it is unrecoverable.