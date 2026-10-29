import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { skillsFor, writeWorkspace } from '../src/commands/workspace.js';
import { tempDir } from './helpers.js';

describe('searvia workspace', () => {
  it("rewrites Searvia's files and keeps the user's files", () => {
    const root = tempDir();
    writeFileSync(join(root, 'client.md'), 'my notes');
    const result = writeWorkspace(root, [
      { path: 'CLAUDE.md', owner: 'searvia', content: 'rules' },
      { path: 'data/keywords.csv', owner: 'searvia', content: 'keyword\n' },
      { path: 'client.md', owner: 'you', content: 'template' },
      { path: 'wiki.md', owner: 'you', content: 'wiki' },
    ]);
    expect(result.written).toEqual(['CLAUDE.md', 'data/keywords.csv', 'wiki.md']);
    expect(result.kept).toEqual(['client.md']);
    expect(readFileSync(join(root, 'client.md'), 'utf8')).toBe('my notes');
    expect(existsSync(join(root, 'data', 'keywords.csv'))).toBe(true);
  });

  it('refuses paths outside the folder', () => {
    expect(() => writeWorkspace(tempDir(), [{ path: '../evil.md', owner: 'searvia', content: 'x' }])).toThrow(/outside/);
  });

  it('picks app skills for apps and the rest for websites', () => {
    const names = ['ai-visibility-audit', 'app-rank-drop', 'aso-weekly-review', 'local-lead-finder'];
    expect(skillsFor('app', names)).toEqual(['ai-visibility-audit', 'app-rank-drop', 'aso-weekly-review']);
    expect(skillsFor('web', names)).toEqual(['ai-visibility-audit', 'local-lead-finder']);
  });
});
