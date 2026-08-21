# Dashboard-Switch-Matrix (Etappe 25)

Etappe 25 übernimmt ausschließlich die produktiv erreichbaren `Switch`-Controls, die in Etappe 24 bewusst aus der Button-Matrix ausgeschlossen wurden.

## Verbindlicher Prüfvertrag

Jeder erreichbare Switch wird gegen folgende Punkte geprüft:

- Permission / Sichtbarkeit der umgebenden Surface
- `checked`-Quelle und Scope
- `onChange`-Wirkung
- Request-/Persistenzpfad oder explizit lokaler Draft-State
- Loading/Disabled-Verhalten
- Double-Click-/Rapid-Toggle-/Out-of-order-Risiken
- Fehler-/Rollback-Verhalten
- Mobile-/Touch-/Accessibility-Vertrag

## Reviewte Surface-Dateien

- `dashboard-ui/src/pages/ServerSlot.tsx`
- `dashboard-ui/src/components/LeaveCleanupPanel.tsx`
- `dashboard-ui/src/components/GoodbyePanel.tsx`
- `dashboard-ui/src/components/FeedsTab.tsx`
- `dashboard-ui/src/components/EmbedBuilderTab.tsx`
- `dashboard-ui/src/components/WelcomeCoreTab.tsx`
- `dashboard-ui/src/components/ReactionEmbedsTab.tsx`
- `dashboard-ui/src/components/economy/VirtualAccountsPanel.tsx`

`tests/security/dashboardSwitchMatrixArchitecture.test.ts` traversiert fail-closed den realen Importgraphen ab `dashboard-ui/src/App.tsx`. Neue produktiv erreichbare Switch-Surfaces müssen dadurch bewusst in diese Etappe aufgenommen werden und dürfen nicht still am Audit vorbeilaufen.

## Shared-Control-Härtung

Die gemeinsame `Switch`-Komponente liefert jetzt explizit:

- `role="switch"`
- `aria-checked`
- stabilen zugänglichen Namen über `label` bzw. optional `ariaLabel`
- `aria-disabled` zusätzlich zum nativen `disabled`
- dekorativen Thumb mit `aria-hidden`
- `type="button"`
- bestehenden mobilen Mindest-Touchbereich über den Wrapper

## Kritische Kopplungen

Der Leave-Cleanup-Switch bleibt bewusst ein lokaler Draft-Schalter und wird erst durch den separaten Speichern-Button persistiert. Aktivierung aus AUS→EIN bleibt hinter expliziter Bestätigung; ein bloßes Umschalten darf keine Cleanup-Saga starten.

Die drei Slot-Settings-Switches schreiben ausschließlich über den guild-/slot-gescopten Settings-Endpunkt. Whitelist-, Economy- und Perma-Only-State dürfen nicht auf andere Guilds/Slots ausweichen.

Weitere fachliche Rapid-Toggle-/Recovery-Verifikation wird innerhalb dieser Etappe vor Gate 1 abgeschlossen; jede daraus folgende Code-/Teständerung setzt den SHA wieder auf 0/2.
