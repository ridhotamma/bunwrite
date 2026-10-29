# Taste

## Workflow
- Expects a fix to start from understanding the whole code and flow plus established framework best practices — find and explain the root cause before editing, rather than patching symptoms. Confidence: 0.55

## Communication
- Once a design question has been discussed, wants the conclusion implemented rather than more analysis or option lists ("can you just fix it??") — explanations should be brief and followed by the actual change.
  Confidence: 0.55

## UI & UX
- Wants sibling forms/pages to behave alike ("make it just like functions"): same option order, same default selection, same interaction pattern — rather than each page inventing its own.
  Confidence: 0.5
- Prefers repeated external data (e.g. GitHub repository/branch lists) cached so revisiting a page or reopening a picker does not refetch.
  Confidence: 0.45

## Code quality & refactoring
- Values maintainability over minimal-diff churn: asks for code to be made "cleaner, scalable" and welcomes refactors that deduplicate shared logic into one place, split oversized modules, and separate pure rendering from data loading. Confidence: 0.55
- Wants new capabilities opt-in and "minimal footprint": env-flag/config-gated, zero added packages, processes, or image size when disabled, rather than new heavyweight dependencies baked into the default deployment. Confidence: 0.55

## Feature scope & compatibility
- For new features/behaviors, wants the implementation to mirror Appwrite's ("follow appwrite … to minimalize error/issues", "just like appwrite cli") — same endpoints, defaults, flows and error semantics — instead of inventing a bespoke design. Confidence: 0.6
