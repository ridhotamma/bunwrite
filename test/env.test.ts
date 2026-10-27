import { describe, expect, test } from 'bun:test'

import { EnvParseError, parseEnvVariables } from '~/functions/env'

describe('bulk env parsing', () => {
  test('parses comments, export, quotes and values containing =', () => {
    expect(parseEnvVariables('A=1\n\n# note\nexport B="two words"\nC=x=y\nD=\'single quoted\'')).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: 'two words' },
      { key: 'C', value: 'x=y' },
      { key: 'D', value: 'single quoted' },
    ])
  })

  test('reports invalid lines with line numbers', () => {
    try {
      parseEnvVariables('A=1\nBAD LINE\n2BAD=x')
      throw new Error('expected parse to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(EnvParseError)
      expect((error as EnvParseError).issues).toEqual(['Line 2: expected KEY=value.', 'Line 3: "2BAD" is not a valid variable name.'])
    }
  })

  test('rejects empty input', () => {
    expect(() => parseEnvVariables('# only a comment\n')).toThrow(EnvParseError)
  })
})
