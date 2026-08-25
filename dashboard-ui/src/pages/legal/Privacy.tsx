import { LegalContact, LegalLayout, LegalSection } from './LegalLayout';

export default function Privacy() {
  return (
    <LegalLayout title="Datenschutzerklärung">
      <LegalSection title="1. Verantwortlicher und Kontakt">
        <p>Diese Datenschutzerklärung beschreibt die Verarbeitung personenbezogener Daten durch V-Bot, das V-Bot Dashboard und die damit verbundenen Discord-, DayZ-/Nitrado- und KI-Funktionen.</p>
        <LegalContact />
      </LegalSection>

      <LegalSection title="2. Welche Daten V-Bot verarbeitet">
        <p>Bei der Anmeldung über Discord verarbeitet V-Bot insbesondere Discord-ID, Benutzername, Profilinformationen, E-Mail-Adresse sowie die von Discord bereitgestellten Serverinformationen. Der OAuth-Login verwendet die Scopes <strong className="text-white">identify</strong>, <strong className="text-white">guilds</strong> und <strong className="text-white">email</strong>.</p>
        <p>Zur sicheren Anmeldung und Sitzungsverwaltung können außerdem Session-Kennung, IP-Adresse, Browser-/Gerätekennung (User-Agent), Zeitpunkte von Anmeldungen und sicherheitsrelevante Ereignisse verarbeitet werden. Discord-Access-Tokens werden nur kurzfristig im Arbeitsspeicher gehalten; ein OAuth-Refresh-Token kann verschlüsselt serverseitig gespeichert werden, damit eine bestehende Verbindung erneuert werden kann.</p>
        <p>Abhängig von den aktivierten Serverfunktionen verarbeitet V-Bot außerdem Discord-Guild-, Channel-, Rollen- und Mitgliedsdaten, Nitrado-Verbindungs- und Gameserver-Metadaten, DayZ-ADM-/RPT-Ereignisse, Whitelist- und Spielerverknüpfungen, Economy- und Buchungsdaten, Moderations- und Auditdaten, Tickets sowie vom Nutzer bereitgestellte XML-/JSON-Dateien oder andere Funktionsdaten.</p>
      </LegalSection>

      <LegalSection title="3. Zwecke der Verarbeitung">
        <p>Die Daten werden verwendet, um Nutzer zu authentifizieren, berechtigte Discord-Server anzuzeigen, V-Bot-Funktionen bereitzustellen, Einstellungen zu speichern, Nitrado-/DayZ-Funktionen auszuführen, Economy-Buchungen nachvollziehbar und gegen Doppelbuchungen geschützt zu verarbeiten, Missbrauch zu verhindern, Fehler zu diagnostizieren und sicherheitsrelevante Vorgänge zu protokollieren.</p>
        <p>Wenn KI-Funktionen ausdrücklich genutzt werden, können die für die jeweilige Anfrage notwendigen Inhalte an den aktuell konfigurierten KI-Anbieter übermittelt werden. V-Bot trennt allgemeine, DayZ-, Discord-Server- und Nutzerkontexte technisch, damit nicht benötigte Kontextdaten nicht in fachfremde Anfragen einfließen.</p>
      </LegalSection>

      <LegalSection title="4. Rechtsgrundlagen">
        <p>Je nach Nutzung erfolgt die Verarbeitung insbesondere zur Durchführung der angeforderten V-Bot-Dienste und Nutzungsvereinbarung, aufgrund berechtigter Interessen an sicherem und stabilem Betrieb sowie – soweit eine Verarbeitung eine gesonderte Einwilligung erfordert – auf Grundlage dieser Einwilligung. Gesetzliche Aufbewahrungs- oder Nachweispflichten bleiben unberührt.</p>
      </LegalSection>

      <LegalSection title="5. Empfänger und externe Dienste">
        <p>V-Bot verwendet Discord als Kommunikations- und Identitätsplattform sowie – nur bei entsprechend konfigurierten Funktionen – Nitrado für Gameserver-Zugriffe und externe KI-Dienste für KI-Anfragen. Technisch notwendige Infrastruktur- und Hosting-Dienstleister können Daten im Rahmen des Betriebs verarbeiten. Eine Weitergabe für Werbezwecke oder ein Verkauf personenbezogener Daten durch V-Bot findet nicht statt.</p>
        <p>Bei externen Diensten gelten zusätzlich deren Datenschutzbestimmungen. Abhängig vom jeweiligen Dienst kann eine Verarbeitung außerhalb der EU/des EWR stattfinden. V-Bot übermittelt nur die für die konkrete Funktion erforderlichen Daten.</p>
      </LegalSection>

      <LegalSection title="6. Speicherdauer und Löschung">
        <p>V-Bot speichert Daten nur so lange, wie sie für die jeweilige Funktion, Sicherheit, Nachvollziehbarkeit von Buchungen oder gesetzliche Pflichten benötigt werden. Abgelaufene oder widerrufene Sessions und Tokens werden nicht weiter für Zugriffe verwendet. Funktionsdaten können abhängig von ihrem Zweck archiviert oder gelöscht werden; finanzielle bzw. sicherheitsrelevante Auditdaten können länger benötigt werden, um Doppelbuchungen, Manipulation oder Missbrauch nachvollziehen zu können.</p>
        <p>Nutzer können die Löschung oder Einschränkung ihrer personenbezogenen Daten über den oben genannten Kontakt beantragen. Vor einer Löschung kann eine Identitätsprüfung erforderlich sein. Daten, die aufgrund gesetzlicher Pflichten oder zwingender Sicherheits-/Buchungsnachweise noch benötigt werden, werden bis zum Ablauf dieser Gründe gesperrt bzw. nur noch für diesen Zweck verarbeitet.</p>
      </LegalSection>

      <LegalSection title="7. Rechte der betroffenen Personen">
        <p>Im Rahmen der anwendbaren Datenschutzgesetze bestehen insbesondere Rechte auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung, Datenübertragbarkeit und – soweit einschlägig – Widerspruch oder Widerruf einer Einwilligung. Außerdem besteht das Recht, sich bei einer zuständigen Datenschutzaufsichtsbehörde zu beschweren.</p>
      </LegalSection>

      <LegalSection title="8. Sicherheit">
        <p>V-Bot setzt technische und organisatorische Schutzmaßnahmen ein. Dazu gehören unter anderem serverseitige Sitzungsprüfung, verschlüsselte Speicherung sensibler OAuth-Refresh-Tokens, Berechtigungs- und Guild-/Gameserver-Scope-Prüfungen, Idempotenz bei kritischen Buchungen, Audit-Protokollierung und zusätzliche Step-up-Authentisierung für besonders privilegierte Bereiche.</p>
      </LegalSection>

      <LegalSection title="9. Änderungen dieser Datenschutzerklärung">
        <p>Diese Erklärung wird angepasst, wenn sich Funktionen, Datenflüsse, externe Anbieter oder rechtliche Anforderungen wesentlich ändern. Der aktuelle Stand ist oben auf dieser Seite angegeben.</p>
      </LegalSection>
    </LegalLayout>
  );
}
