// Datenschutzhinweis für die Personaldaten-Erfassung (Art. 13 DSGVO).
// Entwurf — bitte einmal von Steuerberater/Datenschutz prüfen lassen.
// Anschrift des Arbeitgebers steht in CONTROLLER.
// Änderungen hier wirken sofort im Onboarding (kein anderer Code nötig).

export const PRIVACY_NOTICE_VERSION = '2026-09'

export const CONTROLLER = 'Café Buur, Seckbächer Gasse 14, 60311 Frankfurt am Main (Kontakt: über die Geschäftsführung)'

export const PRIVACY_NOTICE_SECTIONS = [
  {
    title: 'Wer ist verantwortlich?',
    text: `Verantwortlich für die Verarbeitung deiner Daten ist dein Arbeitgeber: ${CONTROLLER}.`,
  },
  {
    title: 'Welche Daten und wofür?',
    text: 'Wir verarbeiten die Angaben aus diesem Formular (Name, Geburtsdaten, Anschrift, Kontakt, Bankverbindung, Steuer-ID, Sozialversicherungsnummer, Krankenkasse, Angaben zu weiteren Beschäftigungen, Notfallkontakt), um dein Arbeitsverhältnis durchzuführen: Lohnabrechnung und Auszahlung, Meldungen an Sozialversicherung und Finanzamt, Dienstplanung und Zeiterfassung. Den Notfallkontakt nutzen wir nur, wenn dir während der Arbeit etwas zustößt.',
  },
  {
    title: 'Rechtsgrundlage',
    text: 'Art. 6 Abs. 1 lit. b DSGVO (Durchführung des Arbeitsvertrags) und Art. 6 Abs. 1 lit. c DSGVO (gesetzliche Pflichten, z. B. aus Steuer- und Sozialversicherungsrecht), jeweils in Verbindung mit Art. 88 DSGVO und § 26 BDSG. Für den Notfallkontakt: Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse, im Notfall schnell helfen zu können).',
  },
  {
    title: 'Wer sieht die Daten?',
    text: 'In der App nur die Geschäftsführung und die Schichtleitung (Manager). Andere Mitarbeiter sehen deine Daten nicht. Weitergegeben werden die Daten nur, soweit nötig: an die Lohnbuchhaltung bzw. den Steuerberater, an deine Krankenkasse und das Finanzamt (gesetzliche Meldungen) und an unsere Bank für die Lohnzahlung. Technisch wird die App bei Supabase (Datenbank, Server in der EU / Irland) und Vercel (Bereitstellung der Web-App) betrieben; beide handeln nur in unserem Auftrag.',
  },
  {
    title: 'Wie lange?',
    text: 'Für die Dauer des Arbeitsverhältnisses. Danach bewahren wir abrechnungsrelevante Daten nur so lange auf, wie es gesetzlich vorgeschrieben ist (in der Regel 6 bzw. 10 Jahre nach Handels- und Steuerrecht), und löschen sie anschließend. Wird deine Bewerbung/Einladung nicht angenommen, löschen wir die Angaben.',
  },
  {
    title: 'Musst du die Daten angeben?',
    text: 'Die mit * markierten Angaben sind für die Lohnabrechnung gesetzlich bzw. vertraglich erforderlich. Ohne sie können wir dich nicht ordnungsgemäß anmelden und bezahlen. Freiwillige Angaben kannst du leer lassen.',
  },
  {
    title: 'Deine Rechte',
    text: 'Du hast das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung, Datenübertragbarkeit und Widerspruch (Art. 15–21 DSGVO). Wende dich dazu an die Geschäftsführung. Außerdem kannst du dich bei einer Datenschutz-Aufsichtsbehörde beschweren, z. B. beim Hessischen Beauftragten für Datenschutz und Informationsfreiheit.',
  },
]
