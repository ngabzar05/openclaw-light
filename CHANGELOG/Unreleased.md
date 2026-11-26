## Unreleased

### Features (fork: mobile boot — Fase 1, true early-listen)

- Gateway now binds its HTTP socket and answers `/health` before the kernel starts (mobile boot ON only): a minimal early-listen stub serves liveness (`/health` 200), honest not-ready (`/ready` + `/startup` 503 with `Retry-After: 1`), and a starting placeholder shell at `/` (no composer, polls `/ready` every 500 ms, reloads into the full Control UI at ready). The full handler takes over the same socket at `mark("ready")` — no rebind, no dropped connections. `/ready` still means "can chat": it no longer awaits the deferred session migration directly (G1 removed), but chat send stays gated on it (G2/G3), and a settled migration failure now fails startup promptly instead of hanging until timeout. Invalid config is enforced post-bind (same exit 78). A debug registration file is written atomically at `<stateDir>/gateway-registration.json` (`starting` → `ready`, removed on clean close; no credentials). OFF mode is byte-for-byte upstream behavior. Polones companion change required: the tile must distinguish "alive" (`/health`) from "ready" (`/ready`) — see `docs/mobile-fast-boot/PLAN-OPENCODE-PARITY.md` §4 Fase 1.

### Fixes

- Control UI: keep automation editor actions flush with the scroll area's bottom, including on narrow screens and when editing job scratch. (#172176) Thanks @brandon-julio-t!
