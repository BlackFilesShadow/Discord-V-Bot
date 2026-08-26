import { LegalContact, LegalLayout, LegalSection } from './LegalLayout';

export default function Terms() {
  return (
    <LegalLayout title="Nutzungsbedingungen">
      <LegalSection title="1. Geltungsbereich">
        <p>Diese Nutzungsbedingungen gelten für die Nutzung von V-Bot, des V-Bot Dashboards und der dazugehörigen Discord-, DayZ-/Nitrado-, Economy-, Moderations-, Datei- und KI-Funktionen. Mit der Nutzung von V-Bot kommt eine Nutzungsvereinbarung zwischen dem Nutzer bzw. dem verantwortlichen Discord-Serverbetreiber und dem V-Bot-Betreiber zustande.</p>
        <LegalContact />
      </LegalSection>

      <LegalSection title="2. Voraussetzungen und Berechtigungen">
        <p>Für bestimmte Funktionen sind ein Discord-Konto, eine Mitgliedschaft oder Eigentümer-/Administrationsrechte auf einem Discord-Server sowie gegebenenfalls eine gültige Nitrado-Verbindung erforderlich. Nutzer dürfen nur Server, Konten, Dateien und Funktionen verwalten, für die sie tatsächlich berechtigt sind.</p>
        <p>Server-Owner und von ihnen eingesetzte Administratoren sind dafür verantwortlich, Berechtigungen, Channel-Zugriffe, Rollen, Nitrado-Zugänge und Economy-Konfigurationen sorgfältig zu vergeben und Änderungen regelmäßig zu überprüfen.</p>
      </LegalSection>

      <LegalSection title="3. Zulässige Nutzung">
        <p>V-Bot darf nur rechtmäßig und im Einklang mit den Discord- und gegebenenfalls Nitrado-Bedingungen verwendet werden. Untersagt sind insbesondere unbefugter Zugriff, Umgehung von Sicherheitsmechanismen, Manipulation von Buchungen oder Auditdaten, automatisierter Missbrauch, das Einschleusen schädlicher Dateien oder Inhalte sowie die Nutzung zur Verletzung von Rechten Dritter.</p>
      </LegalSection>

      <LegalSection title="4. Economy und virtuelle Konten">
        <p>Economy-Guthaben, virtuelle Konten, Lotterie- und Schwarzmarkt-Systemkonten sind ausschließlich virtuelle Werte innerhalb des jeweiligen V-Bot-/Gameserver-Kontexts. Sie stellen kein gesetzliches Zahlungsmittel, kein E-Geld, keine Bankeinlage und keinen Anspruch auf Auszahlung in reale Währung dar, sofern nicht ausdrücklich und separat etwas anderes vereinbart wurde.</p>
        <p>V-Bot verarbeitet kritische Geldbewegungen transaktional und mit Schutz gegen Doppelbuchungen. Serverbetreiber bleiben dennoch für ihre Economy-Regeln, Freigaben, Kontoverwalter und die sachliche Richtigkeit administrativer Korrekturen verantwortlich.</p>
      </LegalSection>

      <LegalSection title="5. Nitrado- und DayZ-Funktionen">
        <p>V-Bot kann mit vom Serverbetreiber autorisierten Nitrado-Zugängen Serverdaten lesen und – sofern eine Funktion ausdrücklich dafür freigeschaltet ist – Änderungen ausführen. Der Serverbetreiber ist für die Berechtigung zur Nutzung des jeweiligen Nitrado-Dienstes, Backups und die Folgen bewusst ausgelöster Serveränderungen verantwortlich.</p>
      </LegalSection>

      <LegalSection title="6. Dateien und Inhalte">
        <p>Nutzer dürfen nur Dateien und Inhalte hochladen oder verarbeiten lassen, zu deren Nutzung sie berechtigt sind. V-Bot kann Dateien validieren, in Quarantäne verschieben, ablehnen oder entfernen, wenn dies für Sicherheit, Stabilität oder die Einhaltung dieser Bedingungen erforderlich ist.</p>
      </LegalSection>

      <LegalSection title="7. KI-Funktionen">
        <p>KI-Ausgaben können unvollständig oder fehlerhaft sein und ersetzen keine fachliche, rechtliche oder sicherheitskritische Prüfung. Nutzer müssen insbesondere Konfigurations-, DayZ-/Nitrado- und Moderationsvorschläge vor einer produktiven Anwendung prüfen. V-Bot kann je nach Konfiguration unterschiedliche externe KI-Anbieter verwenden.</p>
      </LegalSection>

      <LegalSection title="8. Verfügbarkeit, Wartung und Änderungen">
        <p>Es besteht kein Anspruch auf ununterbrochene Verfügbarkeit einzelner Funktionen. Wartungen, Discord-/Nitrado-Ausfälle, API-Änderungen, Sicherheitsmaßnahmen oder technische Störungen können Funktionen zeitweise einschränken. V-Bot darf Funktionen ändern, ersetzen oder deaktivieren, wenn dies für Sicherheit, Kompatibilität oder Weiterentwicklung erforderlich ist.</p>
      </LegalSection>

      <LegalSection title="9. Sperrung und Beendigung">
        <p>Bei Missbrauch, Sicherheitsrisiken, erheblichen Regelverstößen oder unberechtigter Nutzung kann der Zugriff auf V-Bot-Funktionen vorübergehend oder dauerhaft eingeschränkt werden. Nutzer können die Nutzung jederzeit beenden und – soweit möglich – bestehende Verbindungen und Berechtigungen entfernen.</p>
      </LegalSection>

      <LegalSection title="10. Haftung">
        <p>Es gelten die gesetzlichen Haftungsregelungen. Soweit gesetzlich zulässig, haftet der Betreiber nicht für Schäden, die allein aus Fehlkonfigurationen, unberechtigten Administrationshandlungen, externen Dienstausfällen oder ungeprüfter Übernahme von KI-Ausgaben entstehen. Zwingende gesetzliche Haftung bleibt unberührt.</p>
      </LegalSection>

      <LegalSection title="11. Datenschutz">
        <p>Informationen zur Verarbeitung personenbezogener Daten enthält die öffentlich erreichbare Datenschutzerklärung von V-Bot.</p>
      </LegalSection>

      <LegalSection title="12. Änderungen der Bedingungen">
        <p>Diese Bedingungen können angepasst werden, wenn sich V-Bot-Funktionen, externe Plattformanforderungen oder rechtliche Rahmenbedingungen wesentlich ändern. Der aktuelle Stand ist oben angegeben. Wesentliche Änderungen sollen in angemessener Form bekannt gemacht werden.</p>
      </LegalSection>
    </LegalLayout>
  );
}
