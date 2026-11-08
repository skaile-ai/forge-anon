import { describe, expect, test } from 'bun:test'
import { REGEX_ENTITIES, regexDetector } from '../src/detectors/regex.ts'
import type { EntityKind, Span } from '../src/types.ts'

async function run(text: string, entities?: EntityKind[], masked = text): Promise<Span[]> {
  return regexDetector(entities ? { entities } : {}).detect(text, { masked })
}
const found = (spans: Span[], kind: EntityKind) => spans.filter(s => s.kind === kind).map(s => s.text)

describe('phone and fax', () => {
  test('DE numbers with and without +', async () => {
    const spans = await run('Tel. +49 30 1234567, mobil 0171 1234567, Festnetz 030 7654321.')
    expect(found(spans, 'CONTACT_PHONE')).toEqual(['+49 30 1234567', '0171 1234567', '030 7654321'])
  })

  test('AT and CH numbers through their country prefix', async () => {
    const spans = await run('Praxis +43 1 5871234 und +41 44 668 18 00 sowie +43 664 1234567.')
    expect(found(spans, 'CONTACT_PHONE')).toEqual(['+43 1 5871234', '+41 44 668 18 00', '+43 664 1234567'])
  })

  test('fax context gives CONTACT_FAX', async () => {
    const spans = await run('Tel. +49 30 1234567, Fax: 030 7654321.')
    expect(found(spans, 'CONTACT_PHONE')).toEqual(['+49 30 1234567'])
    expect(found(spans, 'CONTACT_FAX')).toEqual(['030 7654321'])
  })

  test('fax label belongs to the number that follows it only', async () => {
    const spans = await run('Fax 030 1234567 Tel 030 7654321')
    expect(found(spans, 'CONTACT_FAX')).toEqual(['030 1234567'])
    expect(found(spans, 'CONTACT_PHONE')).toEqual(['030 7654321'])
  })

  test('a bare year or short number is not a phone number', async () => {
    const spans = await run('Im Jahr 2024 wurde Nr. 12345 vergeben.')
    expect(spans).toEqual([])
  })

  test('digits of a date, IBAN, email or invalid IP are not reported as phone', async () => {
    const spans = await run(
      'geb. 12.03.2011, IBAN DE89370400440532013000, Mail max1234567@example.de, Host 999.1.1.1'
    )
    expect(found(spans, 'CONTACT_PHONE')).toEqual([])
    expect(found(spans, 'CONTACT_FAX')).toEqual([])
  })

  test('amounts and ranges are not phone numbers; a local number counts only after a phone label', async () => {
    const spans = await run(
      'Beitrag 1.211,87 € bei 150.000 € Einkommen, Spanne 27.000–93.000, Jahre 2015–2025, Gruppe 100-80-60, ' +
        'Alter 0–14 / 15–19. Durchwahl: 2345678, Telefonnummer 7654321.'
    )
    expect(found(spans, 'CONTACT_PHONE')).toEqual(['2345678', '7654321'])
  })
})

describe('IBAN and KVNR', () => {
  test('a valid IBAN (with and without spaces) is detected', async () => {
    expect(found(await run('IBAN DE89 3704 0044 0532 0130 00 ok'), 'ID')).toEqual(['DE89 3704 0044 0532 0130 00'])
    expect(found(await run('IBAN DE89370400440532013000 ok'), 'ID')).toEqual(['DE89370400440532013000'])
  })

  test('a checksum-invalid IBAN is not detected', async () => {
    expect(found(await run('Falsch DE89 3704 0044 0532 0130 01 hier.'), 'ID')).toEqual([])
  })

  test('trailing capitals are not swallowed into the IBAN', async () => {
    expect(found(await run('IBAN DE89 3704 0044 0532 0130 00 ABC.'), 'ID')).toEqual(['DE89 3704 0044 0532 0130 00'])
  })

  test('Krankenversichertennummer', async () => {
    const spans = await run('KVNR A123456789 hier')
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({ kind: 'ID', text: 'A123456789', score: 0.7, detector: 'regex' })
  })
})

describe('email, URL, IP', () => {
  test('email including umlaut local part and domain', async () => {
    const spans = await run('Mail an anna.müller@bücher-müller.example.de oder anna.mueller@example.de.')
    expect(found(spans, 'CONTACT_EMAIL')).toEqual(['anna.müller@bücher-müller.example.de', 'anna.mueller@example.de'])
  })

  test('URLs lose trailing sentence punctuation', async () => {
    const spans = await run('Siehe http://example.de/a?b=1, und www.example.de.')
    expect(found(spans, 'CONTACT_URL')).toEqual(['http://example.de/a?b=1', 'www.example.de'])
  })

  test('IPv4 with octets up to 255 only', async () => {
    const spans = await run('Server 192.168.1.10 und 999.1.1.1 und Version 1.2.3.4.5')
    expect(found(spans, 'CONTACT_IP')).toEqual(['192.168.1.10'])
  })
})

describe('dates', () => {
  test('numeric, ISO and written-out month forms', async () => {
    const spans = await run('geb. 12.03.2011, 2011-03-12, am 5. März 2011 und 12 Sept. 2011')
    expect(found(spans, 'DATE')).toEqual(['12.03.2011', '2011-03-12', '5. März 2011', '12 Sept. 2011'])
  })

  test('two-digit year form', async () => {
    expect(found(await run('am 3.5.11 gesehen'), 'DATE')).toEqual(['3.5.11'])
  })
})

describe('salutation surname', () => {
  test('Frau Dr. med. X yields only the surname', async () => {
    const spans = await run('Frau Dr. med. Müller-Lüdenscheid sah den Patienten.')
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({ kind: 'NAME_EXT', text: 'Müller-Lüdenscheid', score: 0.6 })
  })

  test('Herr Prof. Dr. and a sentence-final surname', async () => {
    const spans = await run('Herrn Prof. Dr. Schmidt. Danach Frau Becker.')
    expect(found(spans, 'NAME_EXT')).toEqual(['Schmidt', 'Becker'])
  })

  test('a salutation without a following capitalised word yields nothing', async () => {
    expect(await run('Die Frau kam und der Herr ging.')).toEqual([])
  })
})

describe('age', () => {
  const ages = async (text: string) => found(await run(text), 'AGE')

  test('-jährig forms', async () => {
    expect(await ages('Die 14-jährige besucht die Schule.')).toEqual(['14-jährige'])
    expect(await ages('Ein 14-jähriger Patient.')).toEqual(['14-jähriger'])
    expect(await ages('Bei der 14-jährigen Patientin.')).toEqual(['14-jährigen'])
    expect(await ages('Sie ist 14jährig.')).toEqual(['14jährig'])
  })

  test('N Jahre alt and im Alter von', async () => {
    expect(await ages('Er ist 14 Jahre alt und lebt hier.')).toEqual(['14 Jahre alt'])
    expect(await ages('Aufnahme im Alter von 14 Jahren.')).toEqual(['im Alter von 14 Jahren'])
    expect(await ages('Im Alter von 14;3 Jahren erstmals.')).toEqual(['Alter von 14;3 Jahren'])
    expect(await ages('Alter: 14')).toEqual(['Alter: 14'])
    expect(await ages('Alter: 14 Jahre, weiblich')).toEqual(['Alter: 14 Jahre'])
  })

  test('KJP notation and J abbreviation', async () => {
    expect(await ages('Mia, 14;3 Jahre, kam.')).toEqual(['14;3 Jahre'])
    expect(await ages('Mia, 14,5 Jahre, kam.')).toEqual(['14,5 Jahre'])
    expect(await ages('Mia (14 J.) kam.')).toEqual(['14 J.'])
    expect(await ages('Mia (14 J) kam.')).toEqual(['14 J'])
    expect(await ages('Mia 14J kam.')).toEqual(['14J'])
  })

  test('a J followed by letters, durations and dates are not ages', async () => {
    expect(await ages('14 Jan und 14 Jugendliche')).toEqual([])
    expect(await ages('Seit 3 Jahren in Behandlung.')).toEqual([])
    expect(await ages('Vor 2 Jahren begann es, seit ca. 2,5 Jahren.')).toEqual([])
    expect(await ages('Für 5 Jahre und nach 4 J. wieder.')).toEqual([])
    expect(await ages('In den letzten 3 Jahren.')).toEqual([])
    expect(await ages('Am 14.03.2011 und 1,14 J.')).toEqual([])
    expect(await ages('Alter: 14.03.2011')).toEqual([])
  })

  test('AGE spans carry kind and score 0.6', async () => {
    const spans = await run('Die 14-jährige kam.')
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({ kind: 'AGE', text: '14-jährige', score: 0.6, detector: 'regex' })
    expect(await run('Die 14-jährige kam.', ['DATE'])).toEqual([])
  })
})

describe('options and masking', () => {
  test('entities option restricts recognizers; default list covers all kinds', async () => {
    const text = 'Mail a@example.de am 12.03.2011'
    expect(found(await run(text, ['DATE']), 'CONTACT_EMAIL')).toEqual([])
    expect(found(await run(text, ['DATE']), 'DATE')).toEqual(['12.03.2011'])
    const kinds = new Set((await run(text)).map(s => s.kind))
    expect([...kinds].every(k => REGEX_ENTITIES.includes(k))).toBe(true)
  })

  test('masked placeholders are skipped; offsets index into the original', async () => {
    const text = 'Mail {{email1}} und b@example.de'
    const masked = text.replace('{{email1}}', ' '.repeat('{{email1}}'.length))
    const spans = await run(text, undefined, masked)
    expect(spans).toHaveLength(1)
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe('b@example.de')
    expect(spans[0]!.text).toBe('b@example.de')
  })

  test('spans are sorted by start', async () => {
    const spans = await run('12.03.2011 a@example.de 030 1234567')
    expect(spans.map(s => s.start)).toEqual([...spans.map(s => s.start)].sort((a, b) => a - b))
  })
})
