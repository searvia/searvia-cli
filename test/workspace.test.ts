import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { needsBundledSkills, writeWorkspace } from '../src/commands/workspace.js';
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

  it('uses the bundled skills only when Searvia sends none', () => {
    const rules = { path: 'CLAUDE.md', owner: 'searvia' as const, content: 'rules' };
    const skill = { path: '.claude/skills/searvia-keyword-gap/SKILL.md', owner: 'searvia' as const, content: 'skill' };
    expect(needsBundledSkills([rules, skill])).toBe(false);
    expect(needsBundledSkills([rules])).toBe(true);
  });
});
