# Contributing to sorostream-sdk

Thank you for your interest in contributing to SoroStream! This repo participates in the **Stellar Wave Program** on [Drips Wave](https://drips.network/wave).

## Wave Contributor Workflow

1. **Browse open issues** — find one labelled `Stellar Wave` with a complexity you're comfortable with.
2. **Apply via Drips Wave** — do **not** begin coding until the maintainer assigns you to the issue.
3. **Fork the repo** and create a branch:
   - Bug fixes: `fix/N-short-description`
   - Features: `feat/N-short-description`
   - Where `N` is the issue number (e.g. `feat/4-event-listener`).
4. **Write code and tests** — `npm test` and `npm run lint` must pass.
5. **Open a PR** — title must reference the issue, body must include `Closes #N`.
6. **Await review** — maintainer reviews and merges. Points awarded once resolved before Wave ends.

## Local Setup

```bash
npm install
npm test       # run vitest unit tests
npm run lint   # TypeScript type check
npm run build  # build with tsup
```

## Code Style

- Strict TypeScript — no `any` types.
- All public methods must have JSDoc comments.
- Use `bigint` for all stroop amounts.
