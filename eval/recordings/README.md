# Recordings

Run the eval against the real model once:

```bash
ANTHROPIC_API_KEY=… npm run eval -- --provider anthropic --record
```

That writes a recording here. Commit it, and CI will replay it on every push. Replays are free and deterministic, and they fail the build if precision, recall or clean-PR noise regress. Re-record whenever you change the prompt, the model or the cases (a stale recording fails with a clear message).
