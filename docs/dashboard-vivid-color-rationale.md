# Dashboard vivid color scope

This change intentionally strengthens only the dashboard presentation layer.

## What changes

- Obsidian accent becomes a stronger crimson.
- Ice accent becomes a stronger electric cyan.
- Shared semantic colors (success, warning, danger, info, planned) become more saturated.
- Primary, secondary, outline, ghost and danger button surfaces gain stronger color identity.
- Active switches, status pills, badges, toasts, selected navigation and subsection tabs become easier to distinguish.
- Dark backgrounds stay dark so the stronger colors remain readable rather than turning the dashboard bright.

## What does not change

- API endpoints or payloads
- React Query keys or mutations
- permissions or scopes
- routing
- realtime behaviour
- dashboard state logic
- Discord embed/faction/radar user-configurable color values

The vivid layer is imported after the existing theme layer so it can be reviewed or tuned independently without rewriting the established theme implementation.
