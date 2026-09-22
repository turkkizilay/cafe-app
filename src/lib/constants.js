// ============================================================
// Café Buur — Deutsche Arbeitsrechtliche Konstanten 2026
// Quellen: BMAS, DRV, ver.di, AOK — Stand: 01.01.2026
// ============================================================

// Mindestlohn (§ 1 MiLoG) — gültig ab 01.01.2026
export const MINDESTLOHN_2026 = 13.90   // €/Stunde
export const MINDESTLOHN_2027 = 14.60   // €/Stunde (Vorschau)

// Minijob-Grenze (dynamisch an Mindestlohn gekoppelt seit 10/2022)
export const MINIJOB_GRENZE_2026        = 603    // €/Monat
export const MINIJOB_GRENZE_JAHR_2026   = 7236   // €/Jahr
export const MINIJOB_MAX_STUNDEN_2026   = 43.38  // Stunden/Monat (603 / 13.90)

// Werkstudenten-Regelung (§ 6 Abs. 1 Nr. 3 SGB V)
export const WERKSTUDENT_WOCHENLIMIT    = 20     // Stunden/Woche (Vorlesungszeit)
export const WERKSTUDENT_MAX_WOCHEN     = 26     // Wochen/Jahr über 20h erlaubt
export const WERKSTUDENT_FERIEN_MAX     = 40     // Stunden/Woche (Semesterferien)

// Pausenregelung (§ 4 ArbZG) — unverändert
export const PAUSE_AB_6H_MINUTEN        = 30     // Minuten Pflichtpause ab 6h Arbeit
export const PAUSE_AB_9H_MINUTEN        = 45     // Minuten Pflichtpause ab 9h Arbeit

// Maximale Arbeitszeiten (§ 3 ArbZG) — unverändert
export const MAX_ARBEITSZEIT_TAG_H      = 10     // Stunden/Tag (absolute Obergrenze)
export const STANDARD_ARBEITSZEIT_TAG_H = 8      // Stunden/Tag (Regelarbeitszeit)

// Lohnfortzahlung Krankheit (§ 3 EFZG) — unverändert
export const LOHNFORTZAHLUNG_TAGE       = 42     // Tage (6 Wochen)

// Urlaubsanspruch (§ 3 BUrlG) — unverändert
export const MINDESTURLAUB_5_TAGE_WOCHE = 20     // Arbeitstage/Jahr (5-Tage-Woche)

// Midijob-Übergangsbereich 2026
export const MIDIJOB_GRENZE_UNTEN       = 603    // €/Monat (= Minijob-Grenze)
export const MIDIJOB_GRENZE_OBEN        = 2000   // €/Monat

// Für interne Warnungen
export const MINDESTLOHN = MINDESTLOHN_2026  // Alias für einfachere Nutzung
export const MINIJOB_LIMIT = MINIJOB_GRENZE_2026

// Aliase — werden in MyHours.jsx, Payroll.jsx etc. verwendet
export const WERKSTUDENT_MONTHLY_LIMIT = 80   // Stunden/Monat (interne Regel Café Buur)
export const WERKSTUDENT_WEEKLY_LIMIT  = 20   // Stunden/Woche im Semester (§6 Abs.1 Nr.3 SGB V)
