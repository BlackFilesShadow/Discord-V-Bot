# ADM gameplay action coverage

## Purpose

This document is the semantic contract between vanilla DayZ ADM output and the V-Bot gameplay feeds. The goal is complete coverage of supported feed categories **without cross-classifying unrelated ADM actions**.

The reference used for the vanilla action contract is the current `BohemiaInteractive/DayZ-Script-Diff` script tree inspected for `PluginAdminLog`, `GetAdminLogMessage()` implementations and direct `AdminLog` calls.

## Hard feed boundaries

| Vanilla ADM producer / action | Typical ADM wording | V-Bot event | Feed |
| --- | --- | --- | --- |
| `PluginAdminLog.PlayerKilled` with a second player identity | `killed by Player ...` / player identity + weapon | `PLAYER_KILLED` | Deathfeed / PVP |
| `PluginAdminLog.Suicide` | `committed suicide` | `PLAYER_SUICIDE` | Deathfeed / Suicide |
| `PluginAdminLog.PlayerKilled` animal/infected branch | `killed by Animal_*` / `killed by ZmbM_*` / `ZmbF_*` | `NPC_KILL` | Deathfeed / Wild |
| engine vehicle evidence | `hit by [vehicle] ... at speed ...` on a DEAD player | `VEHICLE_DEATH` | Deathfeed / Vehicle |
| `PluginAdminLog.OnPlacementComplete` | `placed ...` | `PLACEMENT` | Placement |
| `ActionBuildPart` | `Built <part> on <object> with <tool>` | `BUILD` | Baufeed / Build |
| `ShelterSite` build completion | `built <ShelterType> with Hands` | `BUILD` | Baufeed / Build |
| `ActionMountBarbedWire` | `Mounted BarbedWire on <class>` | `BUILD` | Baufeed / Build |
| `ActionDismantlePart` | `Dismantled <part> from <object> with <tool>` | `DISMANTLE` | Baufeed / Dismantle |
| `ActionDeconstructShelter` | `packed <shelter> with Hands` | `DISMANTLE` | Baufeed / Dismantle |
| `ActionPackTent` | `packed <tent> with Hands` | `DISMANTLE` | Baufeed / Dismantle |
| `ActionFoldBaseBuildingObject` | `folded <object>` | `DISMANTLE` | Baufeed / Dismantle |
| `ActionUnmountBarbedWire` | `Unmounted BarbedWire from <class>` | `DISMANTLE` | Baufeed / Dismantle |
| `ActionDestroyPart` | `destroyed <object> with <tool>` | `DESTROY` | Baufeed / Destroy |
| `ActionDestroyCombinationLock` | `destroyed combination lock with <tool>` | `DESTROY` | Baufeed / Destroy |
| `PluginAdminLog.TotemFlagChange` | `has raised/lowered <flag> on <totem class> at <...>` | `FLAG_RAISED` / `FLAG_LOWERED` | Flaggen-Feed |
| EXE connect/disconnect + ADM player list | connect/disconnect / bare player position | presence / `PLAYER_POSITION` | Online List |

`packed` and `folded` are deliberately `DISMANTLE`: vanilla DayZ actually removes/deconstructs the deployed structure in those actions. A shelter pack calls `Deconstruct()`, a tent pack calls `Pack(true)`, and folding a basebuilding object calls `DestroyConstruction()` while returning its kit.

## Deathfeed: exact cause isolation

Vanilla `PluginAdminLog.PlayerKilled()` does **not** use one uniform non-player cause format:

- player-caused kills contain a second player identity and can safely become `PVP`;
- animals/infected are written through `source.GetType()`, producing vanilla class families such as `Animal_*`, `ZmbM_*` and `ZmbF_*`;
- explosive/other object causes can use the same English `killed by ...` wording but provide a display name instead of a player or wild-source identity.

Therefore V-Bot must never treat every non-player `killed by ...` line as Wild/NPC. Only the explicit vanilla animal/infected classname families are admitted to `NPC_KILL`. An explosion, mine, unknown object or ambiguous display-name cause stays `PLAYER_DIED` raw evidence and is **not** emitted as PVP, NPC, Vehicle or Suicide.

The following explicit vanilla raw-death states are also retained without inventing a visible category:

- `died` / stats death
- `drowned`
- `has drowned while unconscious`
- `bled out`
- `is choosing to respawn`
- `is disconnecting while being unconscious`
- `is disconnecting while being restrained`

`PLAYER_DIED` intentionally has no visible Deathfeed category. This avoids duplicate or misleading posts when DayZ emits a specific supported event plus a later generic death line.

All visible Deathfeed parsing requires a canonical DayZ player prefix with identity and position. Chat/report text that happens to contain `killed by`, `committed suicide`, `hit by` or connect/disconnect wording cannot become a gameplay feed event.

## Actions deliberately not forced into an existing build category

The following vanilla admin-log actions are **not** silently relabelled as Build, Placement, Dismantle or Destroy:

- `repaired ...` from `ActionRepairPart`
- `re-packed ...` from the deprecated `ActionRepackTent`
- `Dug in ...` from `ActionDigInStash`
- `Dug out ...` from `ActionDigOutStash`

They remain raw/unknown ADM evidence until a dedicated, semantically correct product category is introduced. This is intentional isolation, not parser loss.

## Anti-mixing rule

Build/placement classification requires the canonical DayZ player-action prefix containing player identity **and position**. A chat message, player report or arbitrary custom log line that merely contains words such as `built`, `placed` or `dismantled` must never enter a gameplay feed.

Flag actions are likewise accepted only in the canonical `TotemFlagChange` shape with valid actor and totem coordinates. The totem classname is not hard-coded to `TerritoryFlag`; derived vanilla classes such as `StaticFlagPole` are valid because DayZ logs `totem.ClassName()`.

The five UI feed families remain semantically isolated:

- Deathfeed: `PVP`, `SUICIDE`, `NPC`, `VEHICLE`
- Baufeed: `BUILD`, `DISMANTLE`, `DESTROY`
- Placement: `PLACEMENT` only
- Online List: connection/disconnection presence plus `PLAYER_POSITION`
- Flaggen-Feed: `RAISED`, `LOWERED`

No event is routed into a neighbouring family merely to make it visible.

## Server-side logging prerequisites

V-Bot can only classify evidence that DayZ actually writes to ADM. Required server settings include:

- `-adminlog`
- `adminLogPlacement = 1` for Placement
- `adminLogBuildActions = 1` for Build/Dismantle/Destroy and scripted flag/basebuilding actions
- `adminLogPlayerList = 1` when periodic player coordinates are required for the Online List

A parser cannot reconstruct an event that vanilla DayZ never logs. In particular, raw damage/explosive destruction of a structure can occur without a corresponding vanilla build-action line. Such source-side absence must not be replaced by proximity guesses or inferred Dismantle/Destroy events.

## Regression contract

- `tests/modules/admVanillaActionCoverage.test.ts` protects shelters/tents, folding, barbed wire, strict Placement separation, flag totem subclasses, intentional exclusions and build-action chat false-positive rejection.
- `tests/modules/admVanillaDeathCoverage.test.ts` protects PVP/Suicide/Wild/Vehicle isolation, raw environmental/explosive causes and deathfeed chat false-positive rejection.
- `tests/modules/admFeedIsolationRegression.test.ts` protects cross-category negative boundaries used by the Discord delivery layer.
