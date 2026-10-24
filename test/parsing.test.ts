import { describe, expect, it } from 'vitest';
import { parseWorkflow, stepArgv } from '../src/commands/workflow.js';
import { parseArgs, splitCommandLine } from '../src/core/args.js';
import { lineDiff } from '../src/core/diff.js';
import { parseYaml } from '../src/core/yaml.js';

describe('args', () => {
  const specs = [
    { name: 'locale', alias: 'l', type: 'list' as const, description: '' },
    { name: 'min-score', type: 'number' as const, description: '' },
    { name: 'wait', type: 'boolean' as const, default: true, description: '' },
    { name: 'track', type: 'string' as const, description: '' },
  ];
  it('parses values, lists, aliases, negation and globals', () => {
    const parsed = parseArgs(['upload', '-l', 'en-US,tr', '--locale=de-DE', '--min-score', '70', '--no-wait', '--track', 'beta', '-y', '--json', 'file.ipa'], specs);
    expect(parsed.positionals).toEqual(['upload', 'file.ipa']);
    expect(parsed.options).toMatchObject({ locale: ['en-US', 'tr', 'de-DE'], minScore: 70, wait: false, track: 'beta', yes: true, json: true });
  });
  it('rejects unknown options', () => {
    expect(() => parseArgs(['--nope'], specs)).toThrow(/Unknown option/);
  });
  it('splits command lines with quotes', () => {
    expect(splitCommandLine(`research "habit tracker" --country 'US' a\\ b`)).toEqual(['research', 'habit tracker', '--country', 'US', 'a b']);
  });
});

describe('yaml', () => {
  it('parses the workflow subset', () => {
    const doc = parseYaml(`
name: Release # comment
env:
  TRACK: beta
steps:
  - run: audit --min-score 70
  - name: "Push iOS"
    run: push --platform ios
    with:
      locale: [en-US, tr]
      create-locales: true
    yes: true
  - push --platform android
notes: |
  line one
  line two
folded: >-
  a
  b
`);
    expect(doc).toEqual({
      name: 'Release',
      env: { TRACK: 'beta' },
      steps: [
        { run: 'audit --min-score 70' },
        { name: 'Push iOS', run: 'push --platform ios', with: { locale: ['en-US', 'tr'], 'create-locales': true }, yes: true },
        'push --platform android',
      ],
      notes: 'line one\nline two\n',
      folded: 'a b',
    });
  });
  it('accepts JSON', () => {
    expect(parseYaml('{"steps": ["audit"]}')).toEqual({ steps: ['audit'] });
  });
});

describe('workflow', () => {
  it('builds argv with interpolation, with-flags and inherited --yes', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow syntax under test
    const flow = parseWorkflow('steps:\n  - run: searvia release --track ${TRACK:-production} --version ${VERSION}\n    with:\n      rollout: 10\n      submit: false\n');
    const argv = stepArgv(flow.steps[0] as never, { VERSION: '2.0.0' }, { yes: true });
    expect(argv).toEqual(['release', '--track', 'production', '--version', '2.0.0', '--rollout', '10', '--no-submit', '--yes']);
  });
});

describe('diff', () => {
  it('produces a line diff', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual([
      { op: ' ', line: 'a' },
      { op: '-', line: 'b' },
      { op: '+', line: 'x' },
      { op: ' ', line: 'c' },
    ]);
  });
});
