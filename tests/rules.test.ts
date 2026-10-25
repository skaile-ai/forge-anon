import { describe, expect, test } from 'bun:test'
import { addCandidate, applyRules, buildRules, residualScan, toMapping } from '../src/rules.ts'
import { gemtexStyle, semanticStyle } from '../src/placeholders.ts'
import { restore } from '../src/restore.ts'
import type { Stammdaten } from '../src/types.ts'

// Ausschließlich erfundene Daten.
const S: Stammdaten = {
  vorname: 'Lena',
  nachname: 'Sommerfeld',
  geburtsdatum: '12.03.2010',
  koseformen: ['Leni'],
  angehoerige: [
    { rolle: 'mutter', vorname: 'Katrin' },
    { rolle: 'vater', vorname: 'Thomas' },
    { rolle: 'Schwester', vorname: 'Mia' },
    { rolle: 'Bruder', vorname: 'Max' }
  ],
  schule: 'Gesamtschule Waldfeld',
  wohnort: 'Lindenau'
}

const rules = buildRules(S)
const run = (t: string) => applyRules(t, rules)

describe('applyRules', () => {
  test('Vorname, Nachname, Vollname', () => {
    expect(run('Lena Sommerfeld kam heute.').text).toBe('{{name}} kam heute.')
    expect(run('Sommerfeld, Lena kam heute.').text).toBe('{{name}} kam heute.')
    expect(run('Lena kam. Sommerfeld auch.').text).toBe('{{vorname}} kam. {{nachname}} auch.')
  })

  test('Genitiv: -s und Apostroph', () => {
    expect(run('Lenas Stimmung war gut.').text).toBe('{{vorname}}s Stimmung war gut.')
    expect(run('Lena\'s Stimmung').text).toBe('{{vorname}}\'s Stimmung')
    expect(run('Sommerfelds Tasche').text).toBe('{{nachname}}s Tasche')
    expect(run('Max\' Zimmer').text).toBe('{{geschwister2}}\' Zimmer')
  })

  test('Koseform', () => {
    const r = run('Leni spielt gern. Lenis Puppe.')
    expect(r.text).toBe('{{vorname}} spielt gern. {{vorname}}s Puppe.')
    expect(r.hits.map(h => h.original)).toEqual(['Leni', 'Leni'])
  })

  test('Frau/Herr <Nachname> -> {{km}}/{{kv}}', () => {
    expect(run('Frau Sommerfeld berichtet.').text).toBe('{{km}} berichtet.')
    expect(run('Herr Sommerfeld berichtet.').text).toBe('{{kv}} berichtet.')
    expect(run('Gespräch mit Frau Sommerfelds Ehemann').text).toBe('Gespräch mit {{km}}s Ehemann')
    expect(run('Familie Sommerfeld').text).toBe('Familie {{nachname}}')
  })

  test('invertierter Name nur ohne vorangehenden Großbuchstaben-Namen', () => {
    expect(run('Heute: Sommerfeld, Lena kam.').text).toBe('Heute: {{name}} kam.')
    expect(run('Lena Sommerfeld, Lenas Mutter').text).toBe('{{name}}, {{vorname}}s Mutter')
  })

  test('Eltern: Vollname und Vorname', () => {
    expect(run('Katrin Sommerfeld und Thomas Sommerfeld').text).toBe('{{km}} und {{kv}}')
    expect(run('Katrin sagt, Thomas schweigt.').text).toBe('{{km_vorname}} sagt, {{kv_vorname}} schweigt.')
  })

  test('Geschwister nummeriert', () => {
    expect(run('Mia und Max streiten.').text).toBe('{{geschwister1}} und {{geschwister2}} streiten.')
  })

  test('abweichender Nachname der Mutter', () => {
    const rs = buildRules({ ...S, angehoerige: [{ rolle: 'mutter', vorname: 'Katrin', nachname: 'Berger' }] })
    expect(applyRules('Frau Berger kam. Berger rief an. Katrin Berger.', rs).text).toBe('{{km}} kam. {{km_nachname}} rief an. {{km}}.')
  })

  test('Geburtsdatum in mehreren Formaten', () => {
    for (const d of ['12.03.2010', '12.3.2010', '12.03.10', '12. März 2010', '12 März 2010', '12/03/2010', '2010-03-12']) {
      expect(run(`geboren am ${d}.`).text).toBe('geboren am {{geburtsdatum}}.')
    }
    // anderes Datum bleibt
    expect(run('am 13.03.2010').text).toBe('am 13.03.2010')
    expect(run('am 112.03.2010').text).toBe('am 112.03.2010')
  })

  test('Geburtsdatum mit einstelligem Tag/Monat', () => {
    const rs = buildRules({ ...S, geburtsdatum: '05.07.2011' })
    expect(applyRules('5.7.2011, 05.07.11, 5. Juli 2011', rs).text).toBe('{{geburtsdatum}}, {{geburtsdatum}}, {{geburtsdatum}}')
  })

  test('keine Ersetzung in anderen Wörtern', () => {
    expect(run('Sommerfelder Schüler').text).toBe('Sommerfelder Schüler')
    expect(run('Plenarsitzung der Lenin-Gruppe').text).toBe('Plenarsitzung der Lenin-Gruppe')
    expect(run('Katrinchen').text).toBe('Katrinchen')
    expect(run('ELENA und Lenaäh').text).toBe('ELENA und Lenaäh')
  })

  test('Umlaute/ß: Wortgrenzen unicode-aware', () => {
    const rs = buildRules({ vorname: 'Jörg', nachname: 'Weiß' })
    expect(applyRules('Jörg Weiß; Jörgs Mutter; Weißer; Jörgen', rs).text).toBe('{{name}}; {{vorname}}s Mutter; Weißer; Jörgen')
  })

  test('case-sensitiv', () => {
    expect(run('lena und LENA').text).toBe('lena und LENA')
  })

  test('Schule und Wohnort; längster Treffer zuerst', () => {
    const r = run('Besucht die Gesamtschule Waldfeld in Lindenau.')
    expect(r.text).toBe('Besucht die {{schule}} in {{wohnort}}.')
    // Schule enthält den Wohnort -> Schule gewinnt (länger)
    const rs = buildRules({ ...S, schule: 'Grundschule Lindenau' })
    expect(applyRules('Grundschule Lindenau', rs).text).toBe('{{schule}}')
  })

  test('hits: Offsets beziehen sich auf den Eingangstext', () => {
    const t = 'Heute kam Lena Sommerfeld mit Frau Sommerfeld.'
    const r = run(t)
    expect(r.hits.map(h => [h.placeholder, h.original, t.slice(h.start, h.end)])).toEqual([
      ['{{name}}', 'Lena Sommerfeld', 'Lena Sommerfeld'],
      ['{{km}}', 'Frau Sommerfeld', 'Frau Sommerfeld']
    ])
    expect(r.hits[0]!.start).toBe(10)
  })

  test('mehrfache Aufrufe sind zustandslos', () => {
    expect(run('Lena').text).toBe('{{vorname}}')
    expect(run('Lena').text).toBe('{{vorname}}')
  })

  test('weitere frei definierte Platzhalter', () => {
    const rs = buildRules({ ...S, weitere: [{ text: 'Dr. Brandt', placeholder: '{{behandler1}}' }] })
    expect(applyRules('Bei Dr. Brandt vorgestellt.', rs).text).toBe('Bei {{behandler1}} vorgestellt.')
  })

  test('Kinds: Patient, Angehörige, Geburtsdatum, Schule, Wohnort', () => {
    const byPlaceholder = (p: string) => [...new Set(rules.filter(r => r.placeholder === p).map(r => r.kind))]
    expect(byPlaceholder('{{name}}')).toEqual(['NAME_PATIENT'])
    expect(byPlaceholder('{{vorname}}')).toEqual(['NAME_PATIENT'])
    expect(byPlaceholder('{{nachname}}')).toEqual(['NAME_PATIENT'])
    for (const p of ['{{km}}', '{{kv}}', '{{km_vorname}}', '{{kv_vorname}}', '{{geschwister1}}', '{{geschwister2}}']) {
      expect(byPlaceholder(p)).toEqual(['NAME_RELATIVE'])
    }
    expect(byPlaceholder('{{geburtsdatum}}')).toEqual(['DATE_BIRTH'])
    expect(byPlaceholder('{{schule}}')).toEqual(['LOCATION_ORGANIZATION'])
    expect(byPlaceholder('{{wohnort}}')).toEqual(['LOCATION_CITY'])
    expect(rules.every(r => r.source === 'rules')).toBe(true)
  })

  test('weitere: Art aus dem Platzhalter', () => {
    const rs = buildRules({
      ...S,
      weitere: [
        { text: 'Dr. Brandt', placeholder: '{{behandler1}}' },
        { text: 'Hohenstein', placeholder: '{{ort2}}' },
        { text: 'Praxis Nord', placeholder: '{{praxis1}}' },
        { text: '01.01.2020', placeholder: '{{datum1}}' }
      ]
    })
    const kind = (p: string) => rs.find(r => r.placeholder === p)!.kind
    expect(kind('{{behandler1}}')).toBe('NAME_EXT')
    expect(kind('{{ort2}}')).toBe('LOCATION_CITY')
    expect(kind('{{praxis1}}')).toBe('LOCATION_ORGANIZATION')
    expect(kind('{{datum1}}')).toBe('DATE')
  })
})

describe('addCandidate', () => {
  test('automatische, eindeutige Platzhalter', () => {
    const c1 = addCandidate(rules, { text: 'Frau Dr. Winter', kind: 'NAME_EXT' }, semanticStyle)
    expect(c1.placeholder).toBe('{{person1}}')
    expect(c1.source).toBe('llm')
    const r2 = [...rules, c1]
    const c2 = addCandidate(r2, { text: 'Herr Kuhn', kind: 'NAME_EXT', source: 'manual' }, semanticStyle)
    expect(c2.placeholder).toBe('{{person2}}')
    expect(c2.source).toBe('manual')
    expect(addCandidate(r2, { text: 'Hohenstein', kind: 'LOCATION_CITY' }, semanticStyle).placeholder).toBe('{{ort1}}')
    expect(addCandidate(r2, { text: 'Klinik am See', kind: 'LOCATION_ORGANIZATION' }, semanticStyle).placeholder).toBe('{{institution1}}')
  })

  test('gleicher Text -> gleicher Platzhalter; explizit überschreibbar', () => {
    const c1 = addCandidate(rules, { text: 'Hohenstein', kind: 'LOCATION_CITY' }, semanticStyle)
    const r2 = [...rules, c1]
    expect(addCandidate(r2, { text: 'Hohenstein', kind: 'LOCATION_CITY' }, semanticStyle).placeholder).toBe(c1.placeholder)
    expect(addCandidate(r2, { text: 'Neustadt', kind: 'LOCATION_CITY', placeholder: '{{x}}' }, semanticStyle).placeholder).toBe('{{x}}')
  })

  test('Kandidat wird angewendet (Wortgrenzen, Genitiv, Leerzeichen)', () => {
    const c = addCandidate(rules, { text: 'Dr. Winter', kind: 'NAME_EXT' }, semanticStyle)
    const r = applyRules('Dr.  Winters Praxis, Dr. Winterfeld', [...rules, c])
    expect(r.text).toBe('{{person1}}s Praxis, Dr. Winterfeld')
  })
})

describe('residualScan', () => {
  const LEAK = 'Lena (Leni) Sommerfeld, geb. 12.03.2010, Gesamtschule Waldfeld in Lindenau; Mutter Katrin, Vater Thomas.'

  test('findet Reste im Rohtext', () => {
    const found = residualScan(LEAK, S, semanticStyle).map(f => f.term.toLowerCase())
    for (const t of ['lena', 'leni', 'sommerfeld', '12.03.2010', 'gesamtschule waldfeld', 'lindenau', 'katrin', 'thomas']) {
      expect(found).toContain(t)
    }
  })

  test('liefert Offsets und ist case-insensitiv', () => {
    const t = 'ruf an: LINDENAU'
    expect(residualScan(t, S, semanticStyle)).toEqual([{ term: 'LINDENAU', index: 8 }])
  })

  test('leer nach vollständiger Anwendung', () => {
    const r = applyRules(LEAK, rules)
    expect(residualScan(r.text, S, semanticStyle)).toEqual([])
  })

  test('Platzhalter selbst lösen keinen Treffer aus', () => {
    const s: Stammdaten = { vorname: 'Name', nachname: 'Vorname Test' }
    expect(residualScan('{{name}} und {{vorname}}', s, semanticStyle)).toEqual([])
  })

  test('Platzhalter anderer Styles werden über den übergebenen Style maskiert', () => {
    const s: Stammdaten = { vorname: 'Anna', nachname: 'Müller' }
    const t = '[** NAME_PATIENT AB12CD **] und Anna'
    expect(residualScan(t, s, gemtexStyle)).toEqual([{ term: 'Anna', index: 32 }])
  })

  test('meldet Ableitungen langer Namen, die applyRules nicht ersetzt', () => {
    const r = applyRules('Die Sommerfelder Schule', rules)
    expect(r.text).toBe('Die Sommerfelder Schule')
    expect(residualScan(r.text, S, semanticStyle).map(f => f.term)).toEqual(['Sommerfelder'])
  })

  test('Geburtsdatum in allen Formaten', () => {
    for (const d of ['12.03.2010', '12.3.10', '12. März 2010', '2010-03-12']) {
      expect(residualScan(`am ${d}`, S, semanticStyle).map(f => f.term)).toEqual([d])
    }
    expect(residualScan('am 13.03.2010', S, semanticStyle)).toEqual([])
  })

  test('kurze Namen (<3 Zeichen) werden nicht gescannt, Teilwörter nicht gemeldet', () => {
    expect(residualScan('Plenarsitzung', S, semanticStyle)).toEqual([])
    expect(residualScan('Ed', { vorname: 'Ed', nachname: 'Li' }, semanticStyle)).toEqual([])
  })

  test('manuell ergänztes Kandidat-Rule löst Rest-Treffer', () => {
    const c = addCandidate(rules, { text: 'Sommerfelder', kind: 'NAME_PATIENT', source: 'manual' }, semanticStyle)
    const r = applyRules('Die Sommerfelder Schule', [...rules, c])
    expect(r.text).toBe('Die {{person1}} Schule')
    expect(residualScan(r.text, S, semanticStyle)).toEqual([])
  })
})

describe('restore', () => {
  const mapping = toMapping(rules)

  test('Roundtrip ohne Koseform', () => {
    const t = 'Lena Sommerfeld, Lenas Mutter Katrin Sommerfeld, Thomas, Mia und Max\' Zimmer. Geboren am 12.03.2010 in Lindenau, Gesamtschule Waldfeld.'
    const p = run(t).text
    expect(residualScan(p, S, semanticStyle)).toEqual([])
    expect(restore(p, mapping)).toBe(t)
  })

  test('Genitiv-Rückersetzung', () => {
    expect(restore('{{vorname}}s Stimmung', mapping)).toBe('Lenas Stimmung')
  })

  test('Koseform wird zum Vornamen, unbekannte Platzhalter bleiben', () => {
    expect(restore(run('Leni lacht').text, mapping)).toBe('Lena lacht')
    expect(restore('{{unbekannt}} {{vorname}}', mapping)).toBe('{{unbekannt}} Lena')
  })

  test('erster Mapping-Eintrag je Platzhalter gewinnt', () => {
    expect(restore('{{km}}', [{ placeholder: '{{km}}', original: 'A' }, { placeholder: '{{km}}', original: 'B' }])).toBe('A')
  })
})
