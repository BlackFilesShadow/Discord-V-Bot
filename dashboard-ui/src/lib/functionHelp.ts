export interface FunctionHelp {
  title: string;
  text: string[];
}

const HELP: Record<string, string[]> = {
  'Virtuelle Konten': ['Verwalte getrennte Konten für diesen Gameserver.', 'Guthaben, Verwalter und Discord-Anzeige bleiben pro Konto getrennt.'],
  Serverbank: ['Die Serverbank ist das zentrale Konto dieses Gameservers.', 'Wallet und Bankreserve werden getrennt geführt.'],
  'Management-Kanal': ['Hier liegt das Discord-Panel für Kontoverwalter.', 'Nur zugewiesene Personen können ihre freigegebenen Konten bedienen.'],
  'Admin-Auszahlung': ['Zahlt Guthaben aus einem CUSTOM-Konto an ein Discord-Mitglied aus.', 'Betrag, Ziel und Buchung werden vor der Auszahlung geprüft.'],
  Lotterie: ['Erstelle und verwalte Lotterie-Runden für diesen Gameserver.', 'Tickets, Ziehung und Auszahlungen werden automatisch protokolliert.'],
  Schwarzmarkt: ['Verwalte Händler und ihre Angebote für diesen Gameserver.', 'Käufe bleiben bis zur manuellen Erfüllung oder Rückzahlung nachvollziehbar.'],
  'Wirtschaft-Status': ['Zeigt den aktuellen Economy-Zustand dieses Gameservers.', 'Die Daten gelten nur für den ausgewählten Slot.'],
  'Economy-Konfiguration': ['Lege Währung, Startguthaben und Regeln für diesen Gameserver fest.', 'Änderungen gelten für neue Vorgänge und verändern keine bestehenden Buchungen.'],
  'Economy-Links (Discord ↔ In-Game)': ['Verbindet Discord-Mitglieder mit ihren DayZ-Spielern.', 'Damit werden Guthaben und Spielaktionen korrekt zugeordnet.'],
  Whitelist: ['Verwalte den Zugang zum ausgewählten Gameserver.', 'Anfragen und Änderungen werden vor der Nitrado-Synchronisierung geprüft.'],
  'Kanal-Integration (Whitelist)': ['Lege fest, in welchem Discord-Kanal Whitelist-Anfragen erscheinen.', 'Der Bot verarbeitet nur Anfragen für den ausgewählten Gameserver.'],
  'Nitrado Gameplay-Feeds': ['Richtet Meldungen aus DayZ-ADM-Protokollen ein.', 'Wähle Ereignisse, Zielkanal und Gameserver für die Zustellung.'],
  'Willkommensnachricht': ['Richte Nachricht und Kanal für neue Mitglieder ein.', 'Eine Vorschau oder Testnachricht prüft die Konfiguration vor der Nutzung.'],
  'Onboarding-Module': ['Zeigt die Funktionen für neue Mitglieder.', 'Willkommen und Auto-Rollen werden hier pro Discord-Server verwaltet.'],
  'Vorschau & Test': ['Prüft die Willkommensnachricht mit Beispielwerten.', 'Die Testnachricht wird nur nach deiner Aktion versendet.'],
  'Fraktionssystem': ['Erstelle und verwalte Fraktionen mit Mitgliedern und Rollen.', 'Änderungen gelten nur für diesen Discord-Server.'],
  Feeds: ['Verwalte automatische RSS-, Plattform- und Webhook-Nachrichten.', 'Jede Quelle sendet nur in den von dir gewählten Discord-Kanal.'],
  'Eingebettete Nachrichten': ['Erstelle und veröffentliche wiederverwendbare Discord-Embeds.', 'Vorschau und Versand erfolgen erst nach der jeweiligen Aktion.'],
  'Reaktions-Embeds': ['Erstelle Menüs, über die Mitglieder Rollen selbst wählen.', 'Rollen und Auswahloptionen werden vor dem Veröffentlichen geprüft.'],
  Übersetzungen: ['Erstelle Nachrichten mit automatischer Übersetzung und Versandzeit.', 'Du bestimmst Inhalt, Zielkanal und Versandmodus.'],
  'Spielerdaten loeschen': ['Steuert den automatischen Umgang mit Spielerdaten beim Austritt.', 'Aktiviere diese Funktion nur, wenn die Löschregeln für deinen Server passen.'],
  'Bye Bye': ['Richtet eine Nachricht für Mitglieder ein, die den Server verlassen.', 'Kanal und Text werden vor dem Speichern geprüft.'],
  'Admin-Stats & Monitor': ['Zeigt aktuelle Systemwerte des Bot-Admin-Bereichs.', 'Die Ansicht ändert keine Einstellungen.'],
  'Error Report': ['Zeigt erfasste Fehler zur technischen Prüfung.', 'Die Daten helfen bei der Ursachenanalyse und ändern nichts am Bot.'],
  Appeals: ['Verwalte Einsprüche gegen Moderationsentscheidungen.', 'Prüfe den Fall und entscheide erst anschließend über Annahme oder Ablehnung.'],
  Feedback: ['Sammelt Rückmeldungen aus dem Discord-Server.', 'Nutze sie zur Prüfung und Verbesserung von Bot-Funktionen.'],
  Broadcast: ['Sendet eine Nachricht an die gewählte Nutzergruppe.', 'Prüfe Empfänger und Text sorgfältig vor dem Versand.'],
  Export: ['Erstellt einen Datenexport für den ausgewählten Bereich.', 'Der Export verändert keine gespeicherten Daten.'],
  Validierung: ['Prüft hochgeladene oder eingegebene Daten auf Fehler.', 'Erst eine erfolgreiche Prüfung erlaubt die nächste Aktion.'],
  Nutzer: ['Verwalte Benutzerinformationen und Berechtigungen.', 'Änderungen wirken auf den ausgewählten Nutzerbereich.'],
  Tickets: ['Zeigt und verwaltet Support-Anfragen.', 'Status und Antworten bleiben im Ticketverlauf nachvollziehbar.'],
};

export function functionHelpFor(title: string): FunctionHelp {
  const normalized = title.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return {
    title: normalized || 'Bereichshilfe',
    text: HELP[normalized] ?? [
      `Hier verwaltest du ${normalized || 'diesen Bereich'}.`,
      'Änderungen werden erst nach der jeweiligen Aktion übernommen.',
    ],
  };
}