// Impressum und Datenschutzhinweise für Beschäftigte – Inhalt DE/EN.
// Grundlage ist die tatsächliche Verarbeitung im Code und in der Datenbank (Stand 28.09.2026).
// Änderungen an Funktionen, die personenbezogene Daten betreffen, müssen hier nachgezogen werden.
// Unternehmensangaben ausschließlich aus den verifizierten Daten – keine Steuernummer, keine Bankdaten.

export const LEGAL_VERSION = '2026-09-28'
// Version der Datenschutzhinweise, deren Kenntnisnahme verlangt wird. Neue Version → alle Konten sehen sie einmal.
export const PRIVACY_NOTICE_VERSION = LEGAL_VERSION

export const COMPANY = {
  name: 'BP Food Revolution GmbH',
  street: 'Fürstenbergstraße 94',
  city: '50226 Frechen',
  representative: 'Mazlum Akyol',
  email: 'info-ffm@cafebuur.de',
  court: 'Amtsgericht Köln',
  register: 'HRB 96756',
  vatId: 'DE322384214',
  site: 'Café Buur Frankfurt',
  siteStreet: 'Seckbächer Gasse 14',
  siteCity: '60311 Frankfurt am Main',
}

const addressLines = country => [COMPANY.name, COMPANY.street, COMPANY.city, country]
const siteLines = country => [COMPANY.site, COMPANY.siteStreet, COMPANY.siteCity, country]

// Block-Typen: { p: 'Absatz' } · { ul: ['Punkt', …] } · { lines: ['Zeile', …] } · { email } · { link: 'imprint'|'privacy', text }

const IMPRINT = {
  de: {
    title: 'Impressum',
    intro: 'Internes Mitarbeiterportal für Beschäftigte von Café Buur Frankfurt.',
    sections: [
      { title: 'Anbieter', blocks: [{ p: 'Angaben gemäß § 5 Digitale-Dienste-Gesetz (DDG) – Firmenanschrift:' }, { lines: addressLines('Deutschland') }] },
      { title: 'Vertreten durch', blocks: [{ p: `Geschäftsführer ${COMPANY.representative}` }] },
      { title: 'Kontakt', blocks: [{ p: 'Kontakt für den Standort Café Buur Frankfurt:' }, { email: COMPANY.email }] },
      { title: 'Registereintrag', blocks: [{ lines: [`Registergericht: ${COMPANY.court}`, `Handelsregister: ${COMPANY.register}`] }] },
      { title: 'Umsatzsteuer-Identifikationsnummer', blocks: [{ p: `Umsatzsteuer-Identifikationsnummer gemäß § 27a Umsatzsteuergesetz: ${COMPANY.vatId}` }] },
      { title: 'Betriebs- und Einsatzort', blocks: [{ p: 'Standort, an dem die Beschäftigten eingesetzt werden und für den das Mitarbeiterportal genutzt wird (nicht Sitz der Gesellschaft):' }, { lines: siteLines('Deutschland') }] },
      { title: 'Datenschutz', blocks: [{ link: 'privacy', text: 'Datenschutzhinweise für Beschäftigte' }] },
    ],
  },
  en: {
    title: 'Legal Notice',
    intro: 'Internal employee portal for staff of Café Buur Frankfurt.',
    sections: [
      { title: 'Provider', blocks: [{ p: 'Information pursuant to Section 5 of the German Digital Services Act (DDG) – company address:' }, { lines: addressLines('Germany') }] },
      { title: 'Represented by', blocks: [{ p: `Managing Director ${COMPANY.representative}` }] },
      { title: 'Contact', blocks: [{ p: 'Contact for the Café Buur Frankfurt location:' }, { email: COMPANY.email }] },
      { title: 'Commercial register', blocks: [{ lines: [`Register court: ${COMPANY.court} (Local Court of Cologne)`, `Commercial register number: ${COMPANY.register}`] }] },
      { title: 'VAT identification number', blocks: [{ p: `VAT identification number pursuant to Section 27a of the German VAT Act: ${COMPANY.vatId}` }] },
      { title: 'Place of business and work', blocks: [{ p: 'Location where staff work and for which the employee portal is used (not the registered office of the company):' }, { lines: siteLines('Germany') }] },
      { title: 'Privacy', blocks: [{ link: 'privacy', text: 'Privacy information for employees' }] },
    ],
  },
}

const PRIVACY = {
  de: {
    title: 'Datenschutzhinweise für Beschäftigte',
    intro: 'Diese Hinweise erklären, welche personenbezogenen Daten das interne Mitarbeiterportal von Café Buur Frankfurt verarbeitet, wofür, auf welcher Rechtsgrundlage und welche Rechte du hast (Art. 13 und 14 DSGVO).',
    sections: [
      { title: '1. Verantwortlicher', blocks: [
        { p: 'Verantwortlich ist die BP Food Revolution GmbH (Firmenanschrift):' },
        { lines: addressLines('Deutschland') },
        { p: `Vertreten durch den Geschäftsführer ${COMPANY.representative}` },
        { p: 'Betriebs- und Einsatzort, für den das Mitarbeiterportal genutzt wird:' },
        { lines: siteLines('Deutschland') },
      ] },
      { title: '2. Kontakt zum Datenschutz', blocks: [
        { p: 'Für Fragen zum Datenschutz und zur Ausübung deiner Rechte wende dich bitte an die Kontaktadresse für den Standort Café Buur Frankfurt:' },
        { email: COMPANY.email },
      ] },
      { title: '3. Zweck des Mitarbeiterportals', blocks: [
        { p: 'Das Portal ist ein internes Werkzeug der BP Food Revolution GmbH für Beschäftigte von Café Buur Frankfurt. Es dient der Organisation und Durchführung des Beschäftigungsverhältnisses: Arbeitszeiterfassung mit Pausen, Dienstplan und Schichttausch, Urlaub und Krankmeldungen, Personaldaten und Dokumente sowie die Vorbereitung der Lohnabrechnung. Das Portal ist nicht für die Öffentlichkeit bestimmt; Konten werden von der Verwaltung eingeladen bzw. freigeschaltet.' },
      ] },
      { title: '4. Welche Daten verarbeitet werden', blocks: [
        { ul: [
          'Konto- und Rollendaten: E-Mail-Adresse, Passwort (wird vom Anmeldedienst nur als Hashwert gespeichert, nicht im Klartext), Name, Rolle (Mitarbeiter/in, Schichtleitung, Verwaltung), Kontostatus, optionales Profilbild.',
          'Stammdaten: Vor- und Nachname, Geburtsname, Geburtsdatum, Geburtsort, Staatsangehörigkeit, Anschrift, Telefonnummer, E-Mail-Adresse, Notfallkontakt (Name und Telefon), Angaben zu weiteren Beschäftigungen.',
          'Beschäftigungsdaten: Position, Beschäftigungsart, Wochenstunden (daraus das Monats-Soll), Eintritts- und Austrittsdatum, Urlaubsanspruch, aktiver/inaktiver Status, interne Notizen der Verwaltung.',
          'Vergütungs- und Abrechnungsdaten: Vergütungsmodell (Stundenlohn oder Fixgehalt), Stundenlohn, Brutto-Monatsgehalt, Bankverbindung (IBAN, Kontoinhaber), Steuer-Identifikationsnummer, Sozialversicherungsnummer, Krankenkasse sowie monatliche Abrechnungswerte (Soll- und Ist-Stunden, Überstunden, Urlaubs- und Krankheitsstunden, Bruttobetrag).',
          'Arbeitszeitdaten: Zeitpunkte des Ein- und Ausstempelns, Beginn und Ende von Pausen, Nettoarbeitszeit, Art der Standortprüfung und Standortdaten (siehe Abschnitt 11), Korrekturen mit altem und neuem Wert, Begründung und bearbeitender Person.',
          'Dienstplandaten: Schichten (Datum, Uhrzeit, Position, Notizen), Tauschanfragen mit Nachricht, Gegenschicht, Status und Freigabe.',
          'Abwesenheitsdaten: Urlaubsanträge (Zeitraum, Tage, Grund, Status, Entscheidung und entscheidende Person), Krankmeldungen (Zeitraum, Notizen, Ende der Entgeltfortzahlung) und Arbeitsunfähigkeitsbescheinigungen (siehe Abschnitt 12).',
          'Dokumente: Lohnabrechnungen und Personalunterlagen (z. B. Verträge), die die Verwaltung hochlädt, sowie Atteste, die du oder die Verwaltung hochladen.',
          'Technische Daten: Benutzer-ID, Zeitstempel, Protokolleinträge (siehe Abschnitt 15), bei aktivierten Push-Benachrichtigungen die Push-Adresse deines Browsers mit Schlüsseln und die Browser-Kennung (User-Agent), sowie der Zeitpunkt, zu dem du im Onboarding die Kenntnisnahme dieser Hinweise bestätigt hast.',
        ] },
      ] },
      { title: '5. Zwecke der Verarbeitung', blocks: [
        { ul: [
          'Personalverwaltung und Durchführung des Beschäftigungsverhältnisses',
          'Arbeitszeiterfassung einschließlich Pausen sowie deren Korrektur',
          'Dienstplanung und Schichttausch',
          'Urlaubs- und Krankheitsverwaltung',
          'Verwaltung von Lohnabrechnungen und Personalunterlagen',
          'Vorbereitung der Lohnabrechnung (Berechnung der Bruttowerte und Export für die Lohnbuchhaltung)',
          'Benachrichtigungen zu Schichten, Anträgen und Dokumenten',
          'IT-Sicherheit, Zugriffsschutz und Nachvollziehbarkeit administrativer Änderungen',
        ] },
      ] },
      { title: '6. Rechtsgrundlagen', blocks: [
        { ul: [
          'Durchführung des Beschäftigungsverhältnisses (Personalverwaltung, Zeiterfassung, Dienstplan, Urlaub, Vergütung): Art. 6 Abs. 1 lit. b DSGVO in Verbindung mit Art. 88 DSGVO und § 26 BDSG.',
          'Erfüllung gesetzlicher Pflichten, z. B. Aufzeichnung von Arbeitszeiten (§ 16 Abs. 2 ArbZG, § 17 MiLoG) sowie steuer- und sozialversicherungsrechtliche Pflichten: Art. 6 Abs. 1 lit. c DSGVO.',
          'Gesundheitsdaten (Krankmeldungen, Arbeitsunfähigkeitsbescheinigungen): Art. 9 Abs. 2 lit. b DSGVO in Verbindung mit § 26 Abs. 3 BDSG, insbesondere zur Erfüllung von Pflichten aus dem Arbeitsrecht und dem Entgeltfortzahlungsgesetz.',
          'Standortprüfung beim Ein- und Ausstempeln, Protokollierung und IT-Sicherheit, Notfallkontakt: Art. 6 Abs. 1 lit. f DSGVO. Unser berechtigtes Interesse ist eine korrekte, manipulationssichere Arbeitszeiterfassung, der Schutz der Daten vor unbefugtem Zugriff, die Nachvollziehbarkeit von Änderungen und die Möglichkeit, im Notfall schnell zu helfen.',
          'Push-Benachrichtigungen: Sie sind freiwillig und werden nur eingerichtet, wenn du sie in deinem Browser aktivierst (Art. 6 Abs. 1 lit. a DSGVO, § 26 Abs. 2 BDSG). Du kannst sie jederzeit in der App oder in den Browser-Einstellungen abschalten.',
          'Die Nutzung des Portals beruht nicht auf einer Einwilligung in die gesamte Verarbeitung deiner Beschäftigtendaten. Die Bestätigung im Onboarding dokumentiert nur, dass du diese Hinweise zur Kenntnis genommen hast.',
        ] },
      ] },
      { title: '7. Wer die Daten sieht (Empfänger)', blocks: [
        { p: 'Innerhalb des Portals ist der Zugriff nach Rollen technisch begrenzt:' },
        { ul: [
          'Kolleginnen und Kollegen: Name, Profilbild, Position, Beschäftigungsart und Wochenstunden sowie den Dienstplan mit allen Schichten. An einer Tauschanfrage Beteiligte sehen diese Anfrage.',
          'Schichtleitung (Manager): operative Daten, insbesondere Kontaktdaten, Geburtsdatum, Beschäftigungsdaten, Arbeitszeiten mit Pausen und Standortdaten, Dienstplan, Urlaub, Krankmeldungen und Atteste. Keinen Zugriff auf Vergütung, Bankverbindung, Steuer-ID, Sozialversicherungsdaten, Lohnabrechnungen und Personalunterlagen.',
          'Verwaltung/Geschäftsführung (Admin): alle Daten, soweit für die Personalverwaltung und Lohnabrechnung erforderlich.',
          'Lohnbuchhaltung bzw. Steuerberatung: Das Portal erzeugt auf Veranlassung der Verwaltung eine Exportdatei (CSV) mit Abrechnungswerten. Diese Datei wird nicht automatisch übertragen; ob und wie sie weitergegeben wird, entscheidet die Verwaltung im Rahmen der Lohnabrechnung.',
          'Technische Dienstleister, die in unserem Auftrag tätig sind: Supabase (Abschnitt 8) und Vercel (Abschnitt 9) sowie für Push-Benachrichtigungen der Push-Dienst deines Browser- bzw. Geräteherstellers (Abschnitt 16).',
        ] },
        { p: 'Das Portal übermittelt keine Daten an Finanzamt, Sozialversicherungsträger oder Banken.' },
      ] },
      { title: '8. Supabase', blocks: [
        { p: 'Das Portal nutzt Supabase (Anbieter: Supabase, Inc.) als technische Plattform. Verwendet werden: die Anmeldung (Konto, Passwort, Sitzung sowie E-Mails zur Kontobestätigung und zum Zurücksetzen des Passworts), die Datenbank für alle in Abschnitt 4 genannten Daten, der Dateispeicher für Dokumente, Atteste und Profilbilder, Datenbankfunktionen, eine Serverfunktion zum Versand von Push-Benachrichtigungen und zeitgesteuerte Aufgaben (wöchentliche Datensicherung, erneuter Versand nicht zugestellter Benachrichtigungen). Die Datenbank des Portals ist in der Supabase-Region EU (Irland) eingerichtet. Beim Zugriff verarbeitet Supabase technisch notwendige Verbindungsdaten wie die IP-Adresse.' },
      ] },
      { title: '9. Vercel', blocks: [
        { p: 'Die Web-App (Programmdateien der Anwendung) wird über Vercel (Anbieter: Vercel Inc.) bereitgestellt. Beim Aufruf verarbeitet Vercel technisch notwendige Verbindungsdaten, insbesondere die IP-Adresse, Zeitpunkt und abgerufene Datei. Deine Personal-, Zeit- und Abrechnungsdaten werden nicht bei Vercel gespeichert, sondern bei Supabase. Analyse- oder Tracking-Dienste von Vercel werden nicht eingesetzt.' },
      ] },
      { title: '10. Übermittlung in Drittländer', blocks: [
        { p: 'Supabase und Vercel sind Unternehmen mit Sitz in den USA. Auch wenn die Portal-Datenbank in der EU eingerichtet ist, kann nicht ausgeschlossen werden, dass diese Anbieter oder ihre Unterauftragnehmer Daten in Drittländern verarbeiten, z. B. im Rahmen von Betrieb und Support. Eine solche Übermittlung ist nur unter den Voraussetzungen der Art. 44 ff. DSGVO zulässig. Welche Garantien im Einzelnen gelten, teilen wir dir auf Anfrage mit.' },
      ] },
      { title: '11. Standortdaten beim Ein- und Ausstempeln', blocks: [
        { p: 'Das Portal prüft beim Ein- und Ausstempeln, ob du dich im Café befindest. Es gibt keine laufende Standortüberwachung und keine Standortabfrage im Hintergrund.' },
        { ul: [
          'Wann: Die Position deines Geräts wird nur abgefragt, solange die Seite „Einstempeln“ geöffnet ist: beim Öffnen und Aktualisieren der Seite, nach dem Ein- oder Ausstempeln und bei einer Pause (beim Neuladen der Seite) sowie wenn du „erneut prüfen“ wählst. Es handelt sich um eine einmalige Abfrage je Vorgang. Dein Browser fragt dich vorher um Erlaubnis.',
          'Pausen: Der Beginn und das Ende einer Pause werden ohne Standortangaben gespeichert.',
          'Prüfung: Die Entfernung zum Café wird berechnet und serverseitig mit dem eingestellten Radius verglichen. Alternativ genügt die Verbindung mit dem Café-WLAN; dafür wird die IP-Adresse deiner Verbindung beim Stempeln mit dem Netz des Cafés verglichen. Deine IP-Adresse wird dabei nicht in deinem Zeiteintrag gespeichert.',
          'Was gespeichert wird: Beim Einstempeln und beim Ausstempeln werden im jeweiligen Zeiteintrag die übermittelten GPS-Koordinaten (Breiten- und Längengrad), das Ergebnis der Prüfung (im Café ja/nein) und die Art der Prüfung (GPS, WLAN oder beides) gespeichert.',
          'Wer sie sehen kann: du selbst, die Schichtleitung und die Verwaltung im Rahmen ihres Zugriffs auf Arbeitszeiten. In der Zeitkorrektur wird die Art der Prüfung angezeigt, nicht die Koordinaten.',
          'Ohne Standort: Ist weder GPS noch Café-WLAN verfügbar, kann das Einstempeln abgelehnt werden. Fehlende oder falsche Zeiten korrigiert die Verwaltung.',
        ] },
      ] },
      { title: '12. Gesundheitsdaten: Krankmeldungen und Atteste', blocks: [
        { p: 'Krankmeldungen enthalten Zeitraum, optionale Notizen und das berechnete Ende der Entgeltfortzahlung. Eine Arbeitsunfähigkeitsbescheinigung kannst du oder die Verwaltung als Datei hochladen; sie wird in einem nicht öffentlichen Dateispeicher abgelegt und ist nur über zeitlich begrenzte Links abrufbar. Diagnosen werden im Portal nicht abgefragt – bitte trage keine Diagnosen in Notizfelder ein. Zugriff haben du selbst, die Schichtleitung und die Verwaltung. Atteste endgültig löschen kann nur die Verwaltung.' },
      ] },
      { title: '13. Vergütung und Lohnabrechnung', blocks: [
        { p: 'Aus den erfassten Arbeitszeiten und dem hinterlegten Vergütungsmodell berechnet das Portal monatliche Werte (Soll- und Ist-Stunden, Überstunden, Urlaubs- und Krankheitsstunden, Bruttobetrag). Bei Fixgehalt ist der Bruttobetrag das hinterlegte Monatsgehalt. Die Verwaltung kann einen Monat abschließen; die Werte werden dann gespeichert. Für die Lohnbuchhaltung erzeugt die Verwaltung eine Exportdatei (siehe Abschnitt 7). Vergütungsdaten sieht nur die Verwaltung, deine eigenen Abrechnungswerte und Lohnabrechnungen siehst du selbst.' },
      ] },
      { title: '14. Dokumente', blocks: [
        { p: 'Lohnabrechnungen (PDF) und Personalunterlagen (z. B. Verträge) lädt die Verwaltung hoch; du kannst deine eigenen Dokumente abrufen. Dateien liegen in nicht öffentlichen Speicherbereichen bei Supabase und werden nur über zeitlich begrenzte Links geöffnet. Den Stundennachweis als PDF erzeugt dein Browser direkt auf deinem Gerät.' },
      ] },
      { title: '15. Sicherheit und Protokolle', blocks: [
        { ul: [
          'Die Verbindung ist verschlüsselt (HTTPS). Der Zugriff auf Daten ist nach Rollen serverseitig begrenzt.',
          'Protokoll: Anmeldungen und Abmeldungen, Passwortänderungen sowie administrative Vorgänge (z. B. Einladungen, Freischaltungen, Rollenänderungen, Lohnexport, Dokument-Uploads, Änderungen von Personaldaten) werden mit Person, Zeitpunkt und Beschreibung protokolliert. Das Protokoll sieht nur die Verwaltung; Einträge werden nach 12 Monaten gelöscht.',
          'Zeitkorrekturen werden mit altem und neuem Wert, Grund und bearbeitender Person gespeichert.',
          'Datensicherung: Einmal pro Woche wird automatisch eine Sicherung der Datenbank erstellt; die Verwaltung kann zusätzlich Sicherungen anlegen und herunterladen. Aufbewahrt werden die letzten 8 automatischen und die letzten 5 manuellen Sicherungen.',
        ] },
      ] },
      { title: '16. Push-Benachrichtigungen', blocks: [
        { p: 'Wenn du Benachrichtigungen aktivierst, speichert das Portal die Push-Adresse deines Browsers mit den zugehörigen Schlüsseln und die Browser-Kennung. Benachrichtigungen (z. B. neue oder geänderte Schichten, Entscheidungen zu Urlaub oder Schichttausch, neue Lohnabrechnungen) werden über den Push-Dienst deines Browser- bzw. Geräteherstellers zugestellt (z. B. Apple, Google, Mozilla oder Microsoft). Der Inhalt wird dabei Ende-zu-Ende verschlüsselt übertragen. Nicht zugestellte Nachrichten werden nach spätestens 7 Tagen gelöscht. Du kannst Benachrichtigungen jederzeit abschalten.' },
      ] },
      { title: '17. Speicherung im Browser, keine Cookies zu Werbe- oder Analysezwecken', blocks: [
        { p: 'Das Portal setzt keine Cookies und verwendet keine Analyse-, Tracking- oder Werbedienste. Im Speicher deines Browsers (localStorage/sessionStorage) werden nur technisch notwendige Angaben abgelegt: die Anmeldesitzung, die Einstellung „angemeldet bleiben“, die gewählte Sprache und Darstellung (hell/dunkel) sowie Anzeigeeinstellungen. Ein Service Worker wird nur für Push-Benachrichtigungen verwendet; Inhalte werden nicht offline zwischengespeichert. Rechtsgrundlage für den Zugriff auf dein Endgerät ist § 25 Abs. 2 Nr. 2 TDDDG.' },
      ] },
      { title: '18. Speicherdauer', blocks: [
        { p: 'Wir speichern Daten, solange sie für die Durchführung des Beschäftigungsverhältnisses erforderlich sind. Danach werden sie gelöscht, soweit keine gesetzlichen Aufbewahrungspflichten (insbesondere aus Steuer-, Sozialversicherungs- und Arbeitszeitrecht) oder Nachweis- und Abrechnungszwecke eine längere Speicherung erfordern. Das Portal enthält dafür eine Löschfunktion, mit der die Verwaltung Daten nach Ablauf der Aufbewahrungsfristen löscht.' },
        { p: 'Konkret im Portal festgelegt sind: Protokolleinträge 12 Monate, Datensicherungen wie in Abschnitt 15 beschrieben, nicht zugestellte Push-Nachrichten höchstens 7 Tage.' },
        { p: 'Dein App-Konto kannst du unter „Mein Konto“ selbst löschen. Daten, die aufbewahrt werden müssen (z. B. Arbeitszeit- und Abrechnungsdaten), bleiben bis zum Ablauf der jeweiligen Frist gespeichert.' },
      ] },
      { title: '19. Deine Rechte', blocks: [
        { p: 'Du hast nach Maßgabe der gesetzlichen Voraussetzungen das Recht auf Auskunft (Art. 15 DSGVO), Berichtigung (Art. 16 DSGVO), Löschung (Art. 17 DSGVO), Einschränkung der Verarbeitung (Art. 18 DSGVO), Datenübertragbarkeit (Art. 20 DSGVO) und Widerspruch gegen Verarbeitungen auf Grundlage berechtigter Interessen (Art. 21 DSGVO). Diese Rechte können eingeschränkt sein, z. B. wenn gesetzliche Aufbewahrungspflichten einer Löschung entgegenstehen. Eine erteilte Einwilligung (Push-Benachrichtigungen) kannst du jederzeit mit Wirkung für die Zukunft widerrufen. Wende dich dazu an die in Abschnitt 2 genannte Adresse.' },
      ] },
      { title: '20. Beschwerderecht', blocks: [
        { p: 'Du kannst dich bei einer Datenschutz-Aufsichtsbehörde beschweren (Art. 77 DSGVO), insbesondere im Mitgliedstaat deines gewöhnlichen Aufenthalts, deines Arbeitsplatzes oder des Orts des mutmaßlichen Verstoßes. Für den Sitz der BP Food Revolution GmbH ist dies die Landesbeauftragte für Datenschutz und Informationsfreiheit Nordrhein-Westfalen, für den Arbeitsort Frankfurt am Main der Hessische Beauftragte für Datenschutz und Informationsfreiheit.' },
      ] },
      { title: '21. Pflicht zur Bereitstellung', blocks: [
        { p: 'Bestimmte Daten sind für die Durchführung des Beschäftigungsverhältnisses und für gesetzliche Pflichten erforderlich (z. B. Name, Anschrift, Bankverbindung, Steuer-ID, Sozialversicherungsnummer, Arbeitszeiten). Ohne sie können wir dich nicht ordnungsgemäß beschäftigen, anmelden und bezahlen. Pflichtangaben sind im Formular gekennzeichnet; freiwillige Angaben kannst du leer lassen. Push-Benachrichtigungen und ein Profilbild sind freiwillig.' },
      ] },
      { title: '22. Keine automatisierten Entscheidungen', blocks: [
        { p: 'Es finden keine ausschließlich automatisierten Entscheidungen im Sinne von Art. 22 DSGVO und kein Profiling statt. Das Portal führt automatische Prüfungen und Hinweise aus – etwa die Standortprüfung beim Stempeln, Hinweise zu Überstunden oder Stundengrenzen und die Markierung von Einträgen, bei denen das Ausstempeln vergessen wurde (über 12 Stunden). Solche markierten Einträge werden erst nach Prüfung und Korrektur durch die Verwaltung bezahlt; über Arbeitszeiten, Urlaub und Vergütung entscheiden Menschen.' },
      ] },
      { title: '23. Änderungen dieser Hinweise', blocks: [
        { p: 'Wir passen diese Hinweise an, wenn sich das Portal oder die rechtlichen Vorgaben ändern. Die aktuelle Fassung ist jederzeit im Portal und auf der Anmeldeseite abrufbar.' },
      ] },
      { title: 'Impressum', blocks: [{ link: 'imprint', text: 'Impressum' }] },
    ],
  },
  en: {
    title: 'Privacy information for employees',
    intro: 'This information explains which personal data the internal employee portal of Café Buur Frankfurt processes, for what purposes, on which legal basis, and what rights you have (Art. 13 and 14 GDPR).',
    sections: [
      { title: '1. Controller', blocks: [
        { p: 'The controller is BP Food Revolution GmbH (company address):' },
        { lines: addressLines('Germany') },
        { p: `Represented by the Managing Director ${COMPANY.representative}` },
        { p: 'Place of business and work for which the employee portal is used:' },
        { lines: siteLines('Germany') },
      ] },
      { title: '2. Data protection contact', blocks: [
        { p: 'For questions about data protection and to exercise your rights, please use the contact address for the Café Buur Frankfurt location:' },
        { email: COMPANY.email },
      ] },
      { title: '3. Purpose of the employee portal', blocks: [
        { p: 'The portal is an internal tool of BP Food Revolution GmbH for staff of Café Buur Frankfurt. It is used to organise and carry out the employment relationship: working time recording including breaks, shift schedule and shift swaps, holidays and sick notes, personal data and documents, and the preparation of payroll. The portal is not intended for the public; accounts are invited or approved by the administration.' },
      ] },
      { title: '4. What data is processed', blocks: [
        { ul: [
          'Account and role data: email address, password (stored by the sign-in service only as a hash, never in plain text), name, role (employee, shift manager, administration), account status, optional profile picture.',
          'Master data: first and last name, birth name, date of birth, place of birth, nationality, address, phone number, email address, emergency contact (name and phone), information on other employment.',
          'Employment data: position, type of employment, weekly hours (used to derive the monthly target), start and end date, holiday entitlement, active/inactive status, internal notes by the administration.',
          'Pay and payroll data: pay model (hourly wage or fixed salary), hourly wage, gross monthly salary, bank details (IBAN, account holder), tax identification number, social security number, health insurance fund, and monthly payroll figures (target and actual hours, overtime, holiday and sick hours, gross amount).',
          'Working time data: clock-in and clock-out times, start and end of breaks, net working time, type of location check and location data (see section 11), corrections with old and new value, reason and editing person.',
          'Shift schedule data: shifts (date, time, position, notes), swap requests with message, counter-shift, status and approval.',
          'Absence data: holiday requests (period, days, reason, status, decision and deciding person), sick notes (period, notes, end of continued pay) and medical certificates of incapacity for work (see section 12).',
          'Documents: payslips and personnel documents (e.g. contracts) uploaded by the administration, and medical certificates uploaded by you or the administration.',
          'Technical data: user ID, timestamps, log entries (see section 15), if push notifications are enabled the push address of your browser with its keys and the browser identifier (user agent), and the time at which you confirmed in onboarding that you have read this information.',
        ] },
      ] },
      { title: '5. Purposes of processing', blocks: [
        { ul: [
          'Personnel administration and performance of the employment relationship',
          'Working time recording including breaks, and corrections',
          'Shift planning and shift swaps',
          'Holiday and sickness management',
          'Management of payslips and personnel documents',
          'Preparation of payroll (calculation of gross figures and export for the payroll accountant)',
          'Notifications about shifts, requests and documents',
          'IT security, access protection and traceability of administrative changes',
        ] },
      ] },
      { title: '6. Legal bases', blocks: [
        { ul: [
          'Performance of the employment relationship (personnel administration, working time, shift schedule, holidays, pay): Art. 6(1)(b) GDPR in conjunction with Art. 88 GDPR and Section 26 of the German Federal Data Protection Act (BDSG).',
          'Compliance with legal obligations, e.g. recording working time (Section 16(2) German Working Hours Act, Section 17 German Minimum Wage Act) and tax and social security obligations: Art. 6(1)(c) GDPR.',
          'Health data (sick notes, medical certificates): Art. 9(2)(b) GDPR in conjunction with Section 26(3) BDSG, in particular to meet obligations under employment law and the German Continued Remuneration Act.',
          'Location check when clocking in and out, logging and IT security, emergency contact: Art. 6(1)(f) GDPR. Our legitimate interest is correct, tamper-resistant working time recording, protecting data against unauthorised access, traceability of changes and being able to help quickly in an emergency.',
          'Push notifications: they are voluntary and are only set up if you enable them in your browser (Art. 6(1)(a) GDPR, Section 26(2) BDSG). You can switch them off at any time in the app or in your browser settings.',
          'Use of the portal is not based on consent to the processing of all your employee data. The confirmation in onboarding only documents that you have read this information.',
        ] },
      ] },
      { title: '7. Who sees the data (recipients)', blocks: [
        { p: 'Within the portal, access is technically limited by role:' },
        { ul: [
          'Colleagues: name, profile picture, position, type of employment and weekly hours, and the shift schedule with all shifts. People involved in a swap request see that request.',
          'Shift managers: operational data, in particular contact details, date of birth, employment data, working times with breaks and location data, shift schedule, holidays, sick notes and medical certificates. No access to pay, bank details, tax ID, social security data, payslips or personnel documents.',
          'Administration/management (admin): all data, as far as required for personnel administration and payroll.',
          'Payroll accountant or tax adviser: at the request of the administration, the portal creates an export file (CSV) with payroll figures. This file is not transferred automatically; the administration decides whether and how it is passed on as part of payroll.',
          'Technical service providers acting on our behalf: Supabase (section 8) and Vercel (section 9), and for push notifications the push service of your browser or device manufacturer (section 16).',
        ] },
        { p: 'The portal does not transmit any data to tax offices, social security institutions or banks.' },
      ] },
      { title: '8. Supabase', blocks: [
        { p: 'The portal uses Supabase (provider: Supabase, Inc.) as its technical platform. The following are used: sign-in (account, password, session, and emails for account confirmation and password reset), the database for all data listed in section 4, file storage for documents, medical certificates and profile pictures, database functions, a server function for sending push notifications, and scheduled tasks (weekly backup, re-sending undelivered notifications). The portal database is set up in the Supabase region EU (Ireland). When accessed, Supabase processes technically necessary connection data such as the IP address.' },
      ] },
      { title: '9. Vercel', blocks: [
        { p: 'The web app (the application files) is delivered via Vercel (provider: Vercel Inc.). When you open the app, Vercel processes technically necessary connection data, in particular the IP address, time and requested file. Your personnel, working time and payroll data are not stored at Vercel but at Supabase. No Vercel analytics or tracking services are used.' },
      ] },
      { title: '10. Transfers to third countries', blocks: [
        { p: 'Supabase and Vercel are companies based in the USA. Even though the portal database is set up in the EU, it cannot be ruled out that these providers or their subcontractors process data in third countries, e.g. for operation and support. Such a transfer is only permitted under the conditions of Art. 44 et seq. GDPR. We will tell you on request which safeguards apply in detail.' },
      ] },
      { title: '11. Location data when clocking in and out', blocks: [
        { p: 'When you clock in or out, the portal checks whether you are at the café. There is no continuous location tracking and no location query in the background.' },
        { ul: [
          'When: your device’s position is only requested while the “Clock in” page is open: when the page is opened or refreshed, after clocking in or out and during a break (when the page reloads), and when you choose “check again”. It is a one-off query per action. Your browser asks for your permission first.',
          'Breaks: the start and end of a break are stored without location information.',
          'Check: the distance to the café is calculated and compared on the server with the configured radius. Alternatively, being connected to the café Wi-Fi is sufficient; for this, the IP address of your connection is compared with the café network when you clock in or out. Your IP address is not stored in your time entry.',
          'What is stored: when clocking in and when clocking out, the transmitted GPS coordinates (latitude and longitude), the result of the check (at the café yes/no) and the type of check (GPS, Wi-Fi or both) are stored in the respective time entry.',
          'Who can see it: you, the shift managers and the administration as part of their access to working times. The time correction view shows the type of check, not the coordinates.',
          'Without location: if neither GPS nor the café Wi-Fi is available, clocking in may be refused. Missing or incorrect times are corrected by the administration.',
        ] },
      ] },
      { title: '12. Health data: sick notes and medical certificates', blocks: [
        { p: 'Sick notes contain the period, optional notes and the calculated end of continued pay. You or the administration can upload a medical certificate of incapacity for work as a file; it is stored in non-public file storage and can only be opened via time-limited links. The portal does not ask for diagnoses – please do not enter diagnoses in note fields. You, the shift managers and the administration have access. Only the administration can permanently delete medical certificates.' },
      ] },
      { title: '13. Pay and payroll', blocks: [
        { p: 'From the recorded working times and the stored pay model, the portal calculates monthly figures (target and actual hours, overtime, holiday and sick hours, gross amount). For a fixed salary, the gross amount is the stored monthly salary. The administration can close a month; the figures are then stored. For the payroll accountant, the administration creates an export file (see section 7). Only the administration sees pay data; you see your own payroll figures and payslips.' },
      ] },
      { title: '14. Documents', blocks: [
        { p: 'Payslips (PDF) and personnel documents (e.g. contracts) are uploaded by the administration; you can open your own documents. Files are kept in non-public storage areas at Supabase and are only opened via time-limited links. Your browser creates the timesheet PDF directly on your device.' },
      ] },
      { title: '15. Security and logs', blocks: [
        { ul: [
          'The connection is encrypted (HTTPS). Access to data is limited by role on the server.',
          'Log: sign-ins and sign-outs, password changes and administrative actions (e.g. invitations, approvals, role changes, payroll exports, document uploads, changes to personal data) are logged with person, time and description. Only the administration can see the log; entries are deleted after 12 months.',
          'Time corrections are stored with old and new value, reason and editing person.',
          'Backups: a backup of the database is created automatically once a week; the administration can also create and download backups. The last 8 automatic and the last 5 manual backups are kept.',
        ] },
      ] },
      { title: '16. Push notifications', blocks: [
        { p: 'If you enable notifications, the portal stores the push address of your browser with its keys and the browser identifier. Notifications (e.g. new or changed shifts, decisions on holidays or shift swaps, new payslips) are delivered via the push service of your browser or device manufacturer (e.g. Apple, Google, Mozilla or Microsoft). The content is transmitted with end-to-end encryption. Undelivered messages are deleted after 7 days at the latest. You can switch notifications off at any time.' },
      ] },
      { title: '17. Browser storage, no cookies for advertising or analytics', blocks: [
        { p: 'The portal does not set cookies and does not use analytics, tracking or advertising services. Only technically necessary information is stored in your browser storage (localStorage/sessionStorage): the sign-in session, the “stay signed in” setting, the selected language and appearance (light/dark), and display settings. A service worker is only used for push notifications; content is not cached offline. The legal basis for accessing your device is Section 25(2) no. 2 of the German Telecommunications Digital Services Data Protection Act (TDDDG).' },
      ] },
      { title: '18. Storage period', blocks: [
        { p: 'We store data for as long as it is required to carry out the employment relationship. It is then deleted unless statutory retention obligations (in particular under tax, social security and working time law) or evidence and payroll purposes require longer storage. For this purpose, the portal contains a deletion function with which the administration deletes data after the retention periods have expired.' },
        { p: 'Specifically defined in the portal: log entries 12 months, backups as described in section 15, undelivered push messages 7 days at most.' },
        { p: 'You can delete your app account yourself under “My account”. Data that must be retained (e.g. working time and payroll data) remains stored until the respective period expires.' },
      ] },
      { title: '19. Your rights', blocks: [
        { p: 'Subject to the statutory requirements, you have the right of access (Art. 15 GDPR), rectification (Art. 16 GDPR), erasure (Art. 17 GDPR), restriction of processing (Art. 18 GDPR), data portability (Art. 20 GDPR) and to object to processing based on legitimate interests (Art. 21 GDPR). These rights may be limited, e.g. if statutory retention obligations prevent erasure. You can withdraw consent you have given (push notifications) at any time with effect for the future. Please contact the address given in section 2.' },
      ] },
      { title: '20. Right to lodge a complaint', blocks: [
        { p: 'You can lodge a complaint with a data protection supervisory authority (Art. 77 GDPR), in particular in the member state of your habitual residence, your place of work or the place of the alleged infringement. For the registered office of BP Food Revolution GmbH this is the State Commissioner for Data Protection and Freedom of Information of North Rhine-Westphalia; for the place of work Frankfurt am Main it is the Hessian Commissioner for Data Protection and Freedom of Information.' },
      ] },
      { title: '21. Obligation to provide data', blocks: [
        { p: 'Certain data is required to carry out the employment relationship and to meet legal obligations (e.g. name, address, bank details, tax ID, social security number, working times). Without it, we cannot employ, register and pay you properly. Mandatory fields are marked in the form; you can leave voluntary fields empty. Push notifications and a profile picture are voluntary.' },
      ] },
      { title: '22. No automated decisions', blocks: [
        { p: 'There are no decisions based solely on automated processing within the meaning of Art. 22 GDPR and no profiling. The portal carries out automatic checks and notices – such as the location check when clocking in or out, notices about overtime or hour limits, and marking entries where clocking out was forgotten (more than 12 hours). Such marked entries are only paid after review and correction by the administration; people decide on working times, holidays and pay.' },
      ] },
      { title: '23. Changes to this information', blocks: [
        { p: 'We update this information when the portal or legal requirements change. The current version is always available in the portal and on the sign-in page.' },
      ] },
      { title: 'Legal Notice', blocks: [{ link: 'imprint', text: 'Legal Notice' }] },
    ],
  },
}

export const LEGAL_PATHS = { imprint: '/impressum', privacy: '/datenschutz' }

export function legalKindForPath(pathname) {
  const p = String(pathname || '').replace(/\/+$/, '')
  return p === LEGAL_PATHS.imprint ? 'imprint' : p === LEGAL_PATHS.privacy ? 'privacy' : null
}

// Rechtstexte gibt es verbindlich auf Deutsch und als Übersetzung auf Englisch. Für Bangla (noch) keine eigene Fassung:
// eine ungeprüfte Übersetzung von Impressum/Datenschutzhinweisen wäre rechtlich riskant → Englisch + Hinweis auf Bangla.
export const legalLanguage = locale => (locale === 'en' || locale === 'bn' ? 'en' : 'de')
export function legalContent(kind, locale) {
  const source = kind === 'imprint' ? IMPRINT : PRIVACY
  return source[legalLanguage(locale)]
}
